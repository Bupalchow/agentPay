require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const macaroons = require('macaroons.js');

const app = express();
app.use(express.json());

const MACAROON_SECRET = "super-secret-hackathon-key";
const VOLTAGE_BASE = `https://voltageapi.com/v1/organizations/${process.env.VOLTAGE_ORG_ID}/environments/${process.env.VOLTAGE_ENV_ID}/payments`;
const VOLTAGE_HEADERS = { 'x-api-key': process.env.VOLTAGE_API_KEY, 'Content-Type': 'application/json' };

// ── In-memory stores ──
// paymentHash → { preimage, invoice, paid, createdAt }
const challenges = new Map();
// clientKey (IP) → { paymentHash, expiresAt }
const clientActiveChallenge = new Map();
const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Helper: Create a Voltage invoice ──
async function createInvoice(amountSats) {
    const paymentId = crypto.randomUUID();

    await axios.post(VOLTAGE_BASE, {
        id: paymentId,
        wallet_id: process.env.VOLTAGE_WALLET_ID,
        payment_kind: 'bolt11',
        amount: { currency: 'btc', amount: amountSats * 1000, unit: 'msats' },
        description: "Tollgate L402 API Access"
    }, { headers: VOLTAGE_HEADERS });

    // Poll until the invoice string is ready
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const { data } = await axios.get(`${VOLTAGE_BASE}/${paymentId}`, { headers: VOLTAGE_HEADERS });
        if (data.data?.payment_request) {
            return { invoice: data.data.payment_request, voltagePaymentId: paymentId };
        }
    }
    throw new Error("Timed out waiting for Voltage to generate the invoice.");
}

// ── Helper: Check if a Voltage receive-payment is settled ──
async function isInvoicePaid(invoice) {
    const { data } = await axios.get(
        `${VOLTAGE_BASE}?wallet_id=${process.env.VOLTAGE_WALLET_ID}&direction=receive&limit=10`,
        { headers: VOLTAGE_HEADERS }
    );
    const match = (data.items || []).find(i => i.data?.payment_request === invoice);
    return match?.status === 'completed';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// THE PAYWALLED ENDPOINT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/data', async (req, res) => {
    const authHeader = req.headers.authorization;

    // ── No token → issue (or re-issue active) 402 challenge ──
    if (!authHeader || !authHeader.startsWith('L402 ')) {
        try {
            const clientIp = req.ip || req.socket.remoteAddress || 'unknown-client';
            const now = Date.now();

            // 1. Check if client already has an active, unpaid challenge within TTL
            const active = clientActiveChallenge.get(clientIp);
            if (active && active.expiresAt > now) {
                const existing = challenges.get(active.paymentHash);
                if (existing && !existing.paid) {
                    const mac = macaroons.MacaroonsBuilder.create("tollgate.local", MACAROON_SECRET, active.paymentHash);
                    console.log(`[402] Re-using active challenge for ${clientIp} hash=${active.paymentHash.slice(0, 16)}…`);
                    return res.status(402)
                        .header('WWW-Authenticate', `L402 macaroon="${mac.serialize()}", invoice="${existing.invoice}"`)
                        .json({ error: "Payment Required to access API", message: "Existing active invoice returned." });
                }
            }

            // 2. Generate a random 32-byte preimage (the secret)
            const preimage = crypto.randomBytes(32).toString('hex');
            // 3. paymentHash = SHA256(preimage)  — this is what the L402 spec requires
            const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
            // 4. Create a Voltage invoice so the client can pay
            const { invoice } = await createInvoice(10);
            // 5. Build a macaroon whose identifier IS the paymentHash
            const mac = macaroons.MacaroonsBuilder.create("tollgate.local", MACAROON_SECRET, paymentHash);

            // 6. Store everything so we can hand back the preimage after payment & cache for client
            challenges.set(paymentHash, { preimage, invoice, paid: false, createdAt: now });
            clientActiveChallenge.set(clientIp, { paymentHash, expiresAt: now + CHALLENGE_TTL_MS });

            console.log(`[402] New challenge issued for ${clientIp} hash=${paymentHash.slice(0, 16)}…`);

            return res.status(402)
                .header('WWW-Authenticate', `L402 macaroon="${mac.serialize()}", invoice="${invoice}"`)
                .json({ error: "Payment Required to access API" });
        } catch (err) {
            console.error("Invoice error:", err.response?.data || err.message);
            return res.status(500).json({ error: "Failed to generate Lightning invoice." });
        }
    }

    // ── Client sent an L402 token → verify it ──
    try {
        const [serializedMac, preimageHex] = authHeader.split(' ')[1].split(':');
        const mac = macaroons.MacaroonsBuilder.deserialize(serializedMac);
        const expectedHash = mac.identifier;

        // Crypto check: SHA256(preimage) must equal the hash baked into the macaroon
        const actualHash = crypto.createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
        if (actualHash !== expectedHash) {
            return res.status(401).json({ error: "Invalid payment preimage." });
        }

        // Macaroon signature check
        if (!new macaroons.MacaroonsVerifier(mac).isValid(MACAROON_SECRET)) {
            return res.status(401).json({ error: "Invalid or forged macaroon." });
        }

        console.log(`[200] Payment verified!  hash=${expectedHash.slice(0, 16)}…`);
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown-client';
        const active = clientActiveChallenge.get(clientIp);
        if (active && active.paymentHash === expectedHash) {
            clientActiveChallenge.delete(clientIp);
        }

        return res.json({
            success: true,
            message: "Tollgate paywall bypassed successfully using Machine Money!",
            data: { asset: "TSLA", price: 245.89, status: "Premium data unlocked" }
        });
    } catch (err) {
        console.error("Verification error:", err);
        return res.status(401).json({ error: "Malformed L402 authorization header." });
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PREIMAGE ENDPOINT — the client calls this AFTER paying the invoice
// Returns the preimage only if the invoice has actually been settled.
// Accepts either paymentHash OR the full invoice string.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/preimage/:identifier', async (req, res) => {
    const identifier = req.params.identifier;
    let challenge = challenges.get(identifier);

    // If not found by paymentHash, look up by invoice string
    if (!challenge) {
        for (const [hash, c] of challenges.entries()) {
            if (c.invoice === identifier) {
                challenge = c;
                break;
            }
        }
    }

    if (!challenge) return res.status(404).json({ error: "Unknown payment hash or invoice." });

    // Check Voltage to confirm the invoice was really paid
    if (!challenge.paid) {
        challenge.paid = await isInvoicePaid(challenge.invoice);
    }

    if (!challenge.paid) {
        return res.status(402).json({ error: "Invoice has not been paid yet." });
    }

    return res.json({ preimage: challenge.preimage });
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Tollgate L402 Proxy listening on http://localhost:${PORT}`));