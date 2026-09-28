const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const bolt11 = require('bolt11');
const macaroons = require('macaroons.js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── Merchant Credentials (Receiver Wallet) ──
const VOLTAGE_ORG_ID = process.env.VOLTAGE_ORG_ID;
const VOLTAGE_ENV_ID = process.env.VOLTAGE_ENV_ID;
const VOLTAGE_API_KEY = process.env.VOLTAGE_API_KEY;
const RECEIVER_WALLET_ID = process.env.VOLTAGE_RECEIVER_WALLET_ID || '21872d9d-de1e-44cc-b2de-b502c0f97406';

const VOLTAGE_BASE = `https://voltageapi.com/v1/organizations/${VOLTAGE_ORG_ID}/environments/${VOLTAGE_ENV_ID}/payments`;
const VOLTAGE_HEADERS = { 'x-api-key': VOLTAGE_API_KEY, 'Content-Type': 'application/json' };

const MACAROON_SECRET = process.env.MACAROON_SECRET || 'merchant_secret_l402_key_8841';

// In-memory cache of generated invoice payment hashes and their payment IDs
const pendingInvoices = new Map();

// ── Decode BOLT11 Invoice ──
function decodeInvoice(invoice) {
    try {
        return bolt11.decode(invoice);
    } catch (err) {
        if (err.message && err.message.includes('Unknown coin bech32 prefix')) {
            const hrp = invoice.slice(0, invoice.lastIndexOf('1'));
            const match = hrp.match(/^ln(\S+?)(\d*)([a-zA-Z]?)$/);
            const prefix = match ? match[1] : 'tbs';
            return bolt11.decode(invoice, {
                bech32: prefix,
                pubKeyHash: 0x6f,
                scriptHash: 0xc4,
                validWitnessVersions: [0, 1]
            });
        }
        throw err;
    }
}

// ── Generate Invoice on Receiver Wallet ──
async function createMerchantInvoice(amountSats) {
    const paymentId = crypto.randomUUID();

    await axios.post(VOLTAGE_BASE, {
        id: paymentId,
        wallet_id: RECEIVER_WALLET_ID,
        payment_kind: 'bolt11',
        amount: { currency: 'btc', amount: amountSats * 1000, unit: 'msats' },
        description: "Merchant Premium API Access (L402)"
    }, { headers: VOLTAGE_HEADERS });

    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const { data } = await axios.get(`${VOLTAGE_BASE}/${paymentId}`, { headers: VOLTAGE_HEADERS });
        if (data.data?.payment_request) {
            const invoice = data.data.payment_request;
            const decoded = decodeInvoice(invoice);
            const paymentHash = decoded.tags.find(t => t.tagName === 'payment_hash').data;
            pendingInvoices.set(paymentHash, paymentId);
            return { invoice, paymentHash, paymentId };
        }
    }
    throw new Error("Timed out waiting for Voltage to generate merchant invoice.");
}

// ── Root / Health ──
app.get('/', (req, res) => {
    res.json({
        service: "Independent Merchant API Server",
        port: PORT,
        receiverWallet: RECEIVER_WALLET_ID,
        paywalledEndpoint: `http://localhost:${PORT}/api/data`
    });
});

// Active challenges map to avoid generating duplicate invoices when the same client retries/probes
// clientKey -> { invoice, paymentHash, paymentId, macaroon, createdAt, settled }
const activeChallenges = new Map();
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MERCHANT PAYWALLED RESOURCE: GET /api/data
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/data', async (req, res) => {
    const authHeader = req.headers.authorization;

    // Case 1: Unauthenticated request -> Issue HTTP 402 Payment Required
    if (!authHeader || !authHeader.startsWith('L402 ')) {
        try {
            const clientKey = `${req.ip || 'client'}:${req.originalUrl || req.path}`;
            const existing = activeChallenges.get(clientKey);

            let invoice, paymentHash, paymentId, serializedMac;

            // If an active unsettled invoice was generated for this client within 5 mins, reuse it!
            if (existing && !existing.settled && (Date.now() - existing.createdAt < CHALLENGE_TTL_MS)) {
                invoice = existing.invoice;
                paymentHash = existing.paymentHash;
                paymentId = existing.paymentId;
                serializedMac = existing.macaroon;
                console.log(`[MERCHANT :${PORT}] Reusing active pending invoice for ${clientKey} (Payment Hash: ${paymentHash.slice(0, 16)}...)`);
            } else {
                console.log(`[MERCHANT :${PORT}] Incoming unauthenticated request -> Creating 10 sat invoice on Receiver Wallet (${RECEIVER_WALLET_ID})...`);
                const created = await createMerchantInvoice(10);
                invoice = created.invoice;
                paymentHash = created.paymentHash;
                paymentId = created.paymentId;

                const mac = macaroons.MacaroonsBuilder.create("merchant.local", MACAROON_SECRET, paymentHash);
                serializedMac = mac.serialize();

                activeChallenges.set(clientKey, {
                    invoice,
                    paymentHash,
                    paymentId,
                    macaroon: serializedMac,
                    createdAt: Date.now(),
                    settled: false
                });

                console.log(`[MERCHANT :${PORT}] 402 Challenge Issued (Payment Hash: ${paymentHash.slice(0, 16)}...)`);
            }

            return res.status(402)
                .header('WWW-Authenticate', `L402 macaroon="${serializedMac}", invoice="${invoice}"`)
                .json({ 
                    error: "Payment Required",
                    priceSats: 10,
                    receiverWallet: RECEIVER_WALLET_ID,
                    invoice: invoice,
                    macaroon: serializedMac,
                    paymentHash: paymentHash,
                    instruction: "Pay this BOLT11 invoice using 'pay_lightning_invoice' or pass { url, invoice, macaroon } to 'fetch_with_l402' to unlock."
                });
        } catch (err) {
            console.error(`[MERCHANT :${PORT}] Failed to generate invoice:`, err.response?.data || err.message);
            return res.status(500).json({ error: "Failed to generate merchant invoice." });
        }
    }

    // Case 2: Client provided L402 Authorization token -> Verify and unlock
    try {
        const parts = authHeader.replace(/^L402\s+/i, '').split(':');
        if (parts.length < 2) {
            return res.status(401).json({ error: "Malformed L402 header. Format: L402 <macaroon>:<preimage>" });
        }

        const serializedMac = parts[0];
        const preimageHex = parts[1];

        const mac = macaroons.MacaroonsBuilder.deserialize(serializedMac);
        const expectedHash = mac.identifier;

        // 1. Signature check on macaroon
        if (!new macaroons.MacaroonsVerifier(mac).isValid(MACAROON_SECRET)) {
            console.warn(`[MERCHANT :${PORT}] Invalid or forged macaroon signature.`);
            return res.status(401).json({ error: "Invalid or forged macaroon." });
        }

        // 2. Cryptographic Preimage verification: SHA256(preimage) must equal paymentHash
        let isPaid = false;
        const actualHash = crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
        if (actualHash === expectedHash) {
            isPaid = true;
        } else {
            // Check Voltage payment status for this invoice
            const paymentId = pendingInvoices.get(expectedHash);
            if (paymentId) {
                // If payment was just broadcast, Voltage ledger may briefly be in 'receiving' state.
                // Poll up to 6 times (3 seconds max) to allow settlement to complete without rejecting the client.
                for (let attempt = 0; attempt < 6; attempt++) {
                    try {
                        const { data } = await axios.get(`${VOLTAGE_BASE}/${paymentId}`, { headers: VOLTAGE_HEADERS });
                        const status = data.data?.status || data.status;
                        if (status === 'completed') {
                            isPaid = true;
                            break;
                        }
                        if (status !== 'receiving') {
                            // If neither completed nor receiving, invoice is unpaid or expired
                            break;
                        }
                        console.log(`[MERCHANT :${PORT}] Invoice ${paymentId.slice(0, 8)} is settling ('receiving')... waiting 500ms (attempt ${attempt + 1}/6)`);
                    } catch (e) {
                        console.warn(`[MERCHANT :${PORT}] Voltage status check warning:`, e.message);
                    }
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        }

        if (!isPaid) {
            console.warn(`[MERCHANT :${PORT}] Payment verification failed for hash ${expectedHash.slice(0, 16)}...`);
            return res.status(401).json({ error: "Payment verification failed. Invoice not settled." });
        }

        console.log(`[MERCHANT :${PORT}] ✅ L402 Verified! Payment confirmed for hash ${expectedHash.slice(0, 16)}...`);

        // Mark challenge settled and clear from activeChallenges so subsequent requests get a fresh invoice
        for (const [key, ch] of activeChallenges.entries()) {
            if (ch.paymentHash === expectedHash) {
                ch.settled = true;
                activeChallenges.delete(key);
            }
        }

        return res.json({
            success: true,
            message: "Merchant API paywall unlocked successfully via Lightning L402!",
            data: {
                asset: "TSLA",
                price: 248.50,
                sentiment: "Bullish",
                volume: "42.1M",
                unlockedAt: new Date().toISOString()
            }
        });
    } catch (err) {
        console.error(`[MERCHANT :${PORT}] L402 verification error:`, err.message);
        return res.status(401).json({ error: "Malformed or invalid L402 authorization header." });
    }
});

const server = app.listen(PORT, () => {
    console.log(`===========================================================`);
    console.log(`  🛒 INDEPENDENT MERCHANT SERVER LISTENING ON PORT ${PORT}`);
    console.log(`  • Receiver Wallet: ${RECEIVER_WALLET_ID}`);
    console.log(`  • Paywalled Route: http://localhost:${PORT}/api/data`);
    console.log(`===========================================================`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ [ERROR] Port ${PORT} is already in use by another process!`);
        console.error(`👉 Run 'netstat -ano | findstr :${PORT}' or kill the background process using port ${PORT}.\n`);
    } else {
        console.error(`\n❌ [ERROR] Merchant server error:`, err);
    }
});
