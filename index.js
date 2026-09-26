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

// ── In-memory store: paymentHash → { preimage, invoice, paid } ──
const challenges = new Map();

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

    // ── No token → issue a 402 challenge ──
    if (!authHeader || !authHeader.startsWith('L402 ')) {
        try {
            // 1. Generate a random 32-byte preimage (the secret)
            const preimage = crypto.randomBytes(32).toString('hex');
            // 2. paymentHash = SHA256(preimage)  — this is what the L402 spec requires
            const paymentHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
            // 3. Create a Voltage invoice so the client can pay
            const { invoice } = await createInvoice(10);
            // 4. Build a macaroon whose identifier IS the paymentHash
            const mac = macaroons.MacaroonsBuilder.create("tollgate.local", MACAROON_SECRET, paymentHash);

            // 5. Store everything so we can hand back the preimage after payment
            challenges.set(paymentHash, { preimage, invoice, paid: false });

            console.log(`[402] Challenge issued  hash=${paymentHash.slice(0, 16)}…`);

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
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/preimage/:paymentHash', async (req, res) => {
    const challenge = challenges.get(req.params.paymentHash);
    if (!challenge) return res.status(404).json({ error: "Unknown payment hash." });

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