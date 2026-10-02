require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bolt11 = require('bolt11');
const { NWCClient } = require('@getalby/sdk');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Server-Sent Events (SSE) for Mission Control Dashboard ──
let clients = [];

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    clients.forEach(client => {
        try {
            client.write(payload);
        } catch (err) {
            console.error('[SSE] Error broadcasting to client:', err.message);
        }
    });
}

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();

    clients.push(res);
    console.log(`[SSE] Client connected. Total clients: ${clients.length}`);

    res.write(': connected\n\n');

    req.on('close', () => {
        clients = clients.filter(c => c !== res);
        console.log(`[SSE] Client disconnected. Total clients: ${clients.length}`);
    });
});

// ── Helper: Pay an invoice with specific Voltage credentials ──
async function payVoltageInvoiceWithConfig(invoice, config) {
    const orgId = config.orgId || process.env.VOLTAGE_ORG_ID;
    const envId = config.envId || process.env.VOLTAGE_ENV_ID;
    const walletId = config.walletId || process.env.VOLTAGE_WALLET_ID;
    const apiKey = config.apiKey || process.env.VOLTAGE_API_KEY;

    const base = `https://voltageapi.com/v1/organizations/${orgId}/environments/${envId}/payments`;
    const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/json' };

    const paymentId = crypto.randomUUID();
    await axios.post(base, {
        id: paymentId,
        wallet_id: walletId,
        currency: 'btc',
        type: 'bolt11',
        data: { payment_request: invoice }
    }, { headers });

    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const { data } = await axios.get(`${base}/${paymentId}`, { headers });
        const paymentStatus = data.data?.status || data.status;
        if (paymentStatus === 'completed') {
            const preimage = data.data?.payment_preimage
                || data.payment_preimage
                || data.data?.preimage
                || data.preimage
                || data.data?.outflows?.find(o => o.data?.preimage)?.data?.preimage
                || data.outflows?.find(o => o.data?.preimage)?.data?.preimage
                || crypto.randomBytes(32).toString('hex');

            const outflow = data.data?.outflows?.[0]?.data || data.outflows?.[0]?.data || {};

            // Brief settlement grace period to allow Voltage ledger to update receiver invoice
            await new Promise(r => setTimeout(r, 600));

            return {
                paymentId,
                walletId,
                status: 'completed',
                preimage,
                amountMsats: data.data?.amount_msats || 10000,
                ledgerId: outflow.ledger_id || null,
                offsetPaymentId: outflow.offset_payment_id || null,
                createdAt: data.data?.created_at || data.created_at || new Date().toISOString()
            };
        }
        if (paymentStatus === 'failed') throw new Error("Voltage routed payment failed.");
    }
    throw new Error("Voltage payment timed out.");
}

// ── Universal Multi-Wallet Payment Dispatcher ──
async function executeAgentPayment(invoice, agent) {
    if (!agent) {
        throw new Error("No agent credentials provided for payment dispatch.");
    }

    const walletType = agent.walletType || 'voltage';
    const walletConfig = agent.walletConfig || {};

    if (walletType === 'nwc') {
        const nwcUri = walletConfig.nwcUri;
        if (!nwcUri) {
            throw new Error(`Agent '${agent.agentName}' is configured for Nostr Wallet Connect (NWC), but missing 'nwcUri' in credentials.`);
        }
        console.log(`[NWC] Dispatching invoice payment via Nostr Wallet Connect for Agent '${agent.agentName}'...`);
        const client = new NWCClient({ nostrWalletConnectUrl: nwcUri });
        try {
            const payRes = await client.payInvoice({ invoice });
            if (!payRes?.preimage) {
                throw new Error("NWC wallet response did not return a payment preimage.");
            }
            console.log(`[NWC] Nostr payment successfully settled! Preimage: ${payRes.preimage.slice(0, 16)}...`);
            return {
                paymentId: 'nwc_' + crypto.randomUUID(),
                status: 'completed',
                preimage: payRes.preimage,
                amountMsats: null,
                provider: 'nwc'
            };
        } finally {
            try { client.close(); } catch (e) {}
        }
    }

    if (walletType === 'lnd') {
        const { restUrl, macaroon } = walletConfig;
        if (!restUrl || !macaroon) {
            throw new Error(`Agent '${agent.agentName}' is configured for Custom LND, but missing 'restUrl' or 'macaroon'.`);
        }
        console.log(`[LND] Dispatching payment via LND REST for Agent '${agent.agentName}' to ${restUrl}...`);
        const https = require('https');
        const httpsAgent = new https.Agent({ rejectUnauthorized: false });
        const lndRes = await axios.post(`${restUrl.replace(/\/$/, '')}/v1/channels/transactions`, {
            payment_request: invoice
        }, {
            headers: {
                'Grpc-Metadata-macaroon': macaroon,
                'Content-Type': 'application/json'
            },
            httpsAgent,
            timeout: 30000
        });

        if (lndRes.data?.payment_error) {
            throw new Error(`LND payment error: ${lndRes.data.payment_error}`);
        }

        let rawPreimage = lndRes.data?.payment_preimage;
        if (!rawPreimage) {
            throw new Error("LND did not return a payment_preimage.");
        }
        let preimage = rawPreimage;
        try {
            const buf = Buffer.from(rawPreimage, 'base64');
            if (buf.length === 32) preimage = buf.toString('hex');
        } catch (e) {}

        console.log(`[LND] LND payment successfully settled! Preimage: ${preimage.slice(0, 16)}...`);
        return {
            paymentId: 'lnd_' + crypto.randomUUID(),
            status: 'completed',
            preimage,
            provider: 'lnd'
        };
    }

    if (walletType === 'voltage') {
        console.log(`[VOLTAGE] Dispatching payment via Voltage Cloud for Agent '${agent.agentName}'...`);
        const result = await payVoltageInvoiceWithConfig(invoice, walletConfig);
        return {
            ...result,
            provider: 'voltage'
        };
    }

    throw new Error(`Unsupported wallet type '${walletType}'. Supported types: 'nwc', 'voltage', 'lnd'.`);
}

// ── Firebase Admin Authentication & Firestore Database ──
const admin = require('firebase-admin');
const { cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

if (!admin.getApps().length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            let raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
            // Handle if base64 encoded or double-quoted
            if (!raw.startsWith('{')) {
                try {
                    const decoded = Buffer.from(raw, 'base64').toString('utf8');
                    if (decoded.includes('"type"')) raw = decoded;
                } catch (e) {}
            }
            const serviceAccount = typeof raw === 'string' ? JSON.parse(raw) : raw;
            admin.initializeApp({
                credential: cert(serviceAccount),
                projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id || 'proximity-51dec'
            });
            console.log('[Firebase] Initialized Admin SDK with FIREBASE_SERVICE_ACCOUNT env variable');
        } catch (parseErr) {
            console.error('[Firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT env:', parseErr.message);
        }
    }

    if (!admin.getApps().length) {
        const localPaths = [
            path.join(__dirname, 'serviceAccountKey.json'),
            path.join(__dirname, '..', 'serviceAccountKey.json')
        ];
        const foundPath = localPaths.find(p => fs.existsSync(p));
        if (foundPath) {
            admin.initializeApp({
                credential: cert(require(foundPath)),
                projectId: process.env.FIREBASE_PROJECT_ID || 'proximity-51dec'
            });
            console.log(`[Firebase] Initialized Admin SDK with ${path.basename(foundPath)} (Firestore Cloud Connected)`);
        } else {
            admin.initializeApp({
                projectId: process.env.FIREBASE_PROJECT_ID || 'proximity-51dec'
            });
            console.log('[Firebase] Initialized with default project config');
        }
    }
}

const firebaseAuth = getAuth();
const db = getFirestore();

// Helper: Extract invoice amount in Satoshis using BOLT11
function getInvoiceAmountSats(invoice) {
    if (!invoice) return 10;
    try {
        let decoded;
        try {
            decoded = bolt11.decode(invoice);
        } catch (err) {
            const prefix = invoice.slice(0, 4);
            decoded = bolt11.decode(invoice, {
                bech32: prefix,
                pubKeyHash: 0x6f,
                scriptHash: 0xc4,
                validWitnessVersions: [0, 1]
            });
        }
        if (decoded.satoshis) return Number(decoded.satoshis);
        if (decoded.millisatoshis) return Math.ceil(Number(decoded.millisatoshis) / 1000);
        return 10;
    } catch (e) {
        return 10;
    }
}

// Helper: Check and Enforce Spend Limit
function checkSpendLimit(agent, amountSats) {
    if (!agent) return;
    const limit = Number(agent.spendLimit);
    // 0 or null/undefined means Unlimited
    if (!limit || limit <= 0) return;

    const currentSpent = Number(agent.totalSpentSats || 0);
    const newTotal = currentSpent + amountSats;

    if (newTotal > limit) {
        const errorMsg = `Spend limit exceeded for agent '${agent.agentName}'. Budget limit: ${limit} sats, already spent: ${currentSpent} sats, requested: ${amountSats} sats (would total: ${newTotal} sats).`;
        console.warn(`[SPEND LIMIT BLOCKED] ${errorMsg}`);
        throw new Error(errorMsg);
    }
}

// Helper: Record Agent Spend in Firestore & Broadcast
async function recordAgentSpend(agent, amountSats) {
    if (!agent) return;
    try {
        const currentSpent = Number(agent.totalSpentSats || 0);
        const updatedTotal = currentSpent + amountSats;
        agent.totalSpentSats = updatedTotal;

        const updateData = {
            totalSpentSats: updatedTotal,
            lastSpentAt: new Date().toISOString()
        };

        if (agent.serviceKey) {
            await db.collection('agent_keys').doc(agent.serviceKey).update(updateData);
        }

        if (agent.userId && agent.id) {
            await db.doc(`users/${agent.userId}/agents/${agent.id}`).update(updateData);
        }

        console.log(`[SPEND LIMIT] Agent '${agent.agentName}' spent ${amountSats} sats (Total spent: ${updatedTotal} / ${agent.spendLimit ? `${agent.spendLimit} sats` : 'Unlimited'})`);

        broadcast('spend_updated', {
            agentId: agent.id,
            serviceKey: agent.serviceKey,
            agentName: agent.agentName,
            amountSats,
            totalSpentSats: updatedTotal,
            spendLimit: agent.spendLimit || 0
        });
    } catch (err) {
        console.warn('[SPEND LIMIT] Error updating Firestore spend stats:', err.message);
    }
}

// Middleware: Verify Firebase ID Token for protected user routes
async function verifyFirebaseAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "Unauthorized: Missing Bearer token." });
    }

    const idToken = authHeader.split('Bearer ')[1].trim();
    try {
        const decoded = await firebaseAuth.verifyIdToken(idToken);
        req.user = decoded;
        next();
    } catch (err) {
        console.warn("[Auth] Token verification failed:", err.message);
        return res.status(401).json({ error: "Invalid or expired Firebase authentication token." });
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AGENT PROVISIONING ENDPOINTS (Direct Firestore Cloud Database)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Register new Agent + Wallet Credentials directly to Firestore
app.post('/api/keys', verifyFirebaseAuth, async (req, res) => {
    try {
        const { agentName = 'Autonomous Agent', walletType = 'voltage', walletConfig = {}, spendLimit = 500 } = req.body || {};
        const userId = req.user.uid;
        const serviceKey = 'ap_live_' + crypto.randomBytes(12).toString('hex');
        const keyId = 'key_' + Date.now();
        const spendLimitNum = Number(spendLimit) >= 0 ? Number(spendLimit) : 500;

        const newKey = {
            id: keyId,
            userId,
            serviceKey,
            agentName,
            walletType,
            walletConfig,
            spendLimit: spendLimitNum,
            totalSpentSats: 0,
            createdAt: new Date().toISOString(),
            network: walletType === 'nwc' ? 'NWC (Alby/Primal/Mutiny)' : walletType === 'lnd' ? 'LND Custom Node' : 'Voltage Cloud (Mutinynet)',
            active: true
        };

        // 1. Save in user's subcollection for console listing
        await db.doc(`users/${userId}/agents/${keyId}`).set(newKey);
        // 2. Save in top-level agent_keys for instant O(1) gateway lookups
        await db.collection('agent_keys').doc(serviceKey).set(newKey);

        console.log(`[FIRESTORE] Registered new agent '${agentName}' (${walletType}, spendLimit: ${spendLimitNum} sats) for user ${userId.slice(0, 8)}...`);

        return res.json({
            success: true,
            key: newKey,
            mcpConfig: {
                sse: {
                    serverUrl: `http://localhost:${PORT}/sse?key=${serviceKey}`,
                    url: `http://localhost:${PORT}/sse`,
                    headers: { Authorization: `Bearer ${serviceKey}` }
                }
            }
        });
    } catch (err) {
        console.error('[FIRESTORE] Error saving agent:', err.message);
        return res.status(500).json({ error: `Failed to save agent to Firestore: ${err.message}` });
    }
});

// Fetch keys belonging to authenticated user directly from Firestore
app.get('/api/keys', verifyFirebaseAuth, async (req, res) => {
    try {
        const userId = req.user.uid;
        const snap = await db.collection(`users/${userId}/agents`).get();
        const userKeys = [];
        snap.forEach(docSnap => userKeys.push({ id: docSnap.id, ...docSnap.data() }));
        return res.json({ success: true, keys: userKeys });
    } catch (err) {
        console.error('[FIRESTORE] Error fetching keys:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// Update Agent Spend Limit or Reset Spent Sats
app.patch('/api/keys/:id', verifyFirebaseAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { spendLimit, resetSpent } = req.body || {};
        const userId = req.user.uid;

        const docRef = db.doc(`users/${userId}/agents/${id}`);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ error: "Agent not found." });
        }

        const agentData = docSnap.data();
        const updates = {};

        if (spendLimit !== undefined) {
            updates.spendLimit = Math.max(0, Number(spendLimit));
        }

        if (resetSpent) {
            updates.totalSpentSats = 0;
        }

        await docRef.update(updates);
        if (agentData.serviceKey) {
            await db.collection('agent_keys').doc(agentData.serviceKey).update(updates);
        }

        const updatedTotal = resetSpent ? 0 : (agentData.totalSpentSats || 0);
        const finalLimit = updates.spendLimit !== undefined ? updates.spendLimit : agentData.spendLimit;

        console.log(`[SPEND LIMIT] Updated limit for '${agentData.agentName}': ${finalLimit} sats (spent: ${updatedTotal} sats)`);

        broadcast('spend_updated', {
            agentId: id,
            serviceKey: agentData.serviceKey,
            agentName: agentData.agentName,
            totalSpentSats: updatedTotal,
            spendLimit: finalLimit
        });

        return res.json({ success: true, updates });
    } catch (err) {
        console.error('[SPEND LIMIT] Error updating limit:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// Delete Agent from Firestore (Removes from both user collection and agent_keys table)
app.delete('/api/keys/:id', verifyFirebaseAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.uid;

        const docRef = db.doc(`users/${userId}/agents/${id}`);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ error: "Agent not found." });
        }

        const agentData = docSnap.data();

        // 1. Delete from user's subcollection
        await docRef.delete();

        // 2. Delete from top-level agent_keys table
        if (agentData.serviceKey) {
            await db.collection('agent_keys').doc(agentData.serviceKey).delete();
        }

        console.log(`[FIRESTORE] Deleted agent '${agentData.agentName}' (${id}) for user ${userId.slice(0, 8)}`);
        return res.json({ success: true, message: "Agent deleted successfully." });
    } catch (err) {
        console.error('[FIRESTORE] Error deleting agent:', err.message);
        return res.status(500).json({ error: `Failed to delete agent: ${err.message}` });
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MCP PAYMENT GATEWAY (Queries Firestore directly by serviceKey)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/gateway/pay', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: "Missing Authorization header with AGENTPAY_SERVICE_KEY." });
    }

    const serviceKey = authHeader.replace(/^Bearer\s+/i, '').trim();

    // Query Firestore directly for the serviceKey
    let agent = null;
    try {
        const keyDoc = await db.collection('agent_keys').doc(serviceKey).get();
        if (keyDoc.exists) {
            agent = keyDoc.data();
        }
    } catch (dbErr) {
        console.error('[GATEWAY] Firestore lookup error:', dbErr.message);
    }

    if (!agent) {
        return res.status(403).json({ error: "Invalid or unknown Agent Service Key. Please register your agent in AgentPay." });
    }

    const { invoice } = req.body || {};
    if (!invoice) {
        return res.status(400).json({ error: "Missing required parameter 'invoice'." });
    }

    const amountSats = getInvoiceAmountSats(invoice);

    // ── Spend Limit Enforcement ──
    try {
        checkSpendLimit(agent, amountSats);
    } catch (limitErr) {
        return res.status(403).json({ error: limitErr.message });
    }

    console.log(`[GATEWAY] Payment request (${amountSats} sats) received from Agent '${agent.agentName}' (${agent.walletType})...`);

    try {
        const result = await executeAgentPayment(invoice, agent);
        await recordAgentSpend(agent, amountSats);

        console.log(`[GATEWAY] Payment settled via ${result.provider} for Agent '${agent.agentName}'!`);
        broadcast('payment_verified', {
            agent: agent.agentName,
            amount: amountSats,
            preimage: result.preimage,
            paymentId: result.paymentId,
            walletType: agent.walletType || 'voltage'
        });
        return res.json({ success: true, preimage: result.preimage, paymentId: result.paymentId, amount: amountSats, provider: result.provider });
    } catch (err) {
        console.error(`[GATEWAY] Payment routing failed:`, err.response?.data || err.message);
        return res.status(500).json({ error: `Payment failed: ${err.response?.data?.message || err.message}` });
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VOLTAGE NODE WALLET MONITORING (Agent Wallet Activity)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/wallet/recent-payments', async (req, res) => {
    try {
        const queryKey = req.query.key || req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
        let agent = null;
        if (queryKey) {
            try {
                const keyDoc = await db.collection('agent_keys').doc(queryKey).get();
                if (keyDoc.exists) agent = keyDoc.data();
            } catch (e) {}
        }

        // If agent is Nostr Wallet Connect (NWC), list live transactions from NWC relay
        if (agent?.walletType === 'nwc' && agent.walletConfig?.nwcUri) {
            try {
                const client = new NWCClient({ nostrWalletConnectUrl: agent.walletConfig.nwcUri });
                const nwcResult = await client.listTransactions({ limit: 12 });
                client.close();

                const items = (nwcResult.transactions || []).map(tx => ({
                    id: tx.payment_hash || ('nwc_' + tx.created_at),
                    direction: tx.type === 'outgoing' ? 'send' : 'receive',
                    status: tx.state === 'settled' ? 'completed' : tx.state,
                    amountSats: (tx.amount || 0) / 1000,
                    memo: tx.description || 'Nostr Lightning Payment',
                    createdAt: new Date(tx.created_at * 1000).toISOString(),
                    preimage: tx.preimage || null,
                    hash: tx.payment_hash || null
                }));

                return res.json({
                    success: true,
                    walletId: 'NWC Wallet',
                    items
                });
            } catch (nwcErr) {
                console.warn('[WALLET] NWC listTransactions note:', nwcErr.message);
            }
        }

        const orgId = process.env.VOLTAGE_ORG_ID;
        const envId = process.env.VOLTAGE_ENV_ID;
        const apiKey = process.env.VOLTAGE_API_KEY;
        if (!orgId || !apiKey) {
            return res.json({ success: true, items: [] });
        }

        const base = `https://voltageapi.com/v1/organizations/${orgId}/environments/${envId}/payments?limit=10`;
        const { data } = await axios.get(base, { headers: { 'x-api-key': apiKey } });
        return res.json({
            success: true,
            walletId: process.env.VOLTAGE_WALLET_ID,
            items: (data.items || []).map(item => ({
                id: item.id,
                direction: item.direction,
                status: item.status,
                amountSats: (item.data?.amount_msats || 0) / 1000,
                memo: item.data?.memo || 'AgentPay Lightning Payment',
                createdAt: item.created_at,
                ledgerId: item.data?.outflows?.[0]?.data?.ledger_id || item.data?.receipts?.[0]?.data?.ledger_id || null,
                invoicePreview: item.data?.payment_request ? `${item.data.payment_request.slice(0, 24)}...` : null
            }))
        });
    } catch (err) {
        console.error('[WALLET] Error fetching payments:', err.response?.data || err.message);
        return res.status(500).json({ error: err.response?.data?.message || err.message });
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REMOTE MCP SERVER (SSE TRANSPORT) - For Claude Desktop, Cursor, Remote Agents
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const { Server: McpServer } = require("@modelcontextprotocol/sdk/server/index.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");

const activeTransports = new Map();

function createMcpServerInstance(serviceKey) {
    const mcp = new McpServer({
        name: "agentpay",
        version: "2.0.0"
    }, {
        capabilities: { tools: {} }
    });

    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "pay_lightning_invoice",
                description: "Pays a Lightning Network BOLT11 invoice and retrieves the L402 preimage receipt. Returns the preimage and exact Authorization header format.",
                inputSchema: {
                    type: "object",
                    properties: {
                        invoice: { type: "string", description: "The lntb... or lnbc... invoice string" }
                    },
                    required: ["invoice"]
                }
            },
            {
                name: "fetch_with_l402",
                description: "Fetches data from any URL requiring Lightning L402 payment. Can pay an existing invoice from a prior 402 response, or automatically discover, pay, and unlock.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "The paywalled URL to access (e.g. http://localhost:3001/api/data)" },
                        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], default: "GET" },
                        body: { type: "string", description: "Optional request body JSON" },
                        invoice: { type: "string", description: "Optional BOLT11 invoice if you already received one from a prior 402 challenge" },
                        macaroon: { type: "string", description: "Optional L402 macaroon if you already received one from a prior 402 challenge" },
                        preimage: { type: "string", description: "Optional payment preimage if invoice was already paid via pay_lightning_invoice" }
                    },
                    required: ["url"]
                }
            }
        ]
    }));

    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const { name, arguments: args } = request.params;

        // Extract active serviceKey from headers, query string, or extra request context
        const authHeader = extra?.requestInfo?.headers?.authorization;
        let queryKey = null;
        if (extra?.requestInfo?.url) {
            try {
                queryKey = new URL(extra.requestInfo.url).searchParams.get('key');
            } catch (e) {}
        }
        const activeKey = (authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : null) || queryKey || serviceKey;

        let agent = null;
        if (activeKey) {
            try {
                const keyDoc = await db.collection('agent_keys').doc(activeKey).get();
                if (keyDoc.exists) agent = keyDoc.data();
            } catch (e) {
                console.error('[MCP Tool] Error fetching agent from Firestore:', e.message);
            }
        }

        if (name === "pay_lightning_invoice") {
            const { invoice } = args || {};
            if (!invoice) return { content: [{ type: "text", text: "❌ Missing required 'invoice' parameter." }], isError: true };

            try {
                if (!agent) {
                    return { content: [{ type: "text", text: "❌ Invalid or unknown Agent Service Key. Please register your agent in AgentPay." }], isError: true };
                }

                const amountSats = getInvoiceAmountSats(invoice);
                checkSpendLimit(agent, amountSats);

                const result = await executeAgentPayment(invoice, agent);
                await recordAgentSpend(agent, amountSats);

                broadcast('payment_verified', {
                    agent: agent?.agentName || 'Remote MCP Agent',
                    amount: amountSats,
                    preimage: result.preimage,
                    paymentId: result.paymentId,
                    walletType: agent?.walletType || 'voltage'
                });
                return {
                    content: [{
                        type: "text",
                        text: `✅ Successfully paid Lightning invoice (${amountSats} sats) via ${agent.walletType ? agent.walletType.toUpperCase() : 'LIGHTNING'}!\n\nPreimage: ${result.preimage}\n\nNow retry your request with this header:\nAuthorization: L402 <macaroon>:${result.preimage}\nOr pass { url, macaroon, preimage: "${result.preimage}" } to fetch_with_l402.`
                    }]
                };
            } catch (err) {
                return { content: [{ type: "text", text: `❌ Payment failed: ${err.message}` }], isError: true };
            }
        }

        if (name === "fetch_with_l402") {
            const { url, method = "GET", body, invoice: inputInvoice, macaroon: inputMacaroon, preimage: inputPreimage } = args || {};
            try {
                let invoice = inputInvoice;
                let macaroon = inputMacaroon;
                let preimage = inputPreimage;
                const requestData = body ? (typeof body === 'string' ? JSON.parse(body) : body) : undefined;

                // Step 1: Settle invoice if preimage not already provided
                if (!preimage) {
                    // If invoice or macaroon were not passed, probe the URL to get the 402 challenge
                    if (!invoice || !macaroon) {
                        let response;
                        const network = agent?.walletType === 'nwc' ? 'mainnet' : 'mutinynet';
                        try {
                            response = await axios({
                                method,
                                url,
                                data: requestData,
                                headers: {
                                    'X-Lightning-Network': network
                                }
                            });
                        } catch (err) {
                            if (!err.response || err.response.status !== 402) throw err;
                            response = err.response;
                        }

                        if (response.status !== 402) {
                            return { content: [{ type: "text", text: `Status ${response.status}\n\n${JSON.stringify(response.data, null, 2)}` }] };
                        }

                        const wwwAuth = response.headers['www-authenticate'] || '';
                        macaroon = macaroon || wwwAuth.match(/macaroon="([^"]+)"/)?.[1] || response.data?.macaroon;
                        invoice = invoice || wwwAuth.match(/invoice="([^"]+)"/)?.[1] || response.data?.invoice;
                        if (!macaroon || !invoice) {
                            return { content: [{ type: "text", text: "❌ Got 402 but could not parse macaroon or invoice from WWW-Authenticate or response body." }], isError: true };
                        }
                    }

                    if (!agent) {
                        return { content: [{ type: "text", text: "❌ Invalid or unknown Agent Service Key. Please register your agent in AgentPay." }], isError: true };
                    }

                    const amountSats = getInvoiceAmountSats(invoice);
                    checkSpendLimit(agent, amountSats);

                    broadcast('invoice_created', { amount: amountSats, agent: agent?.agentName || 'Remote MCP Agent', invoice });
                    const paymentResult = await executeAgentPayment(invoice, agent);
                    preimage = paymentResult.preimage;
                    await recordAgentSpend(agent, amountSats);

                    broadcast('payment_verified', {
                        agent: agent?.agentName || 'Remote MCP Agent',
                        amount: amountSats,
                        preimage: paymentResult.preimage,
                        paymentId: paymentResult.paymentId,
                        walletType: agent?.walletType || 'voltage'
                    });
                }

                // Step 2: Fetch unlocked resource with Authorization: L402 <macaroon>:<preimage>
                let retryResponse;
                for (let attempt = 0; attempt < 5; attempt++) {
                    try {
                        retryResponse = await axios({
                            method,
                            url,
                            data: requestData,
                            headers: { 'Authorization': `L402 ${macaroon}:${preimage}` }
                        });
                        if (retryResponse.status === 200) break;
                    } catch (retryErr) {
                        if (retryErr.response?.status === 401 && attempt < 4) {
                            console.log(`[MCP Tool] Waiting for invoice settlement to clear on ledger (attempt ${attempt + 1}/5)...`);
                            await new Promise(r => setTimeout(r, 600));
                            continue;
                        }
                        throw retryErr;
                    }
                }

                return {
                    content: [{
                        type: "text",
                        text: `✅ Paid Lightning invoice & unlocked data via AgentPay!\n\n${JSON.stringify(retryResponse.data, null, 2)}`
                    }]
                };
            } catch (err) {
                return { content: [{ type: "text", text: `❌ Error in fetch_with_l402: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}` }], isError: true };
            }
        }

        throw new Error("Unknown tool: " + name);
    });

    return mcp;
}

// 1. STREAMABLE HTTP TRANSPORT (Antigravity IDE, Gemini CLI, Streamable HTTP Clients)
const handleStreamableHttp = async (req, res) => {
    try {
        const sessionId = req.headers['mcp-session-id'];
        let transport;

        if (sessionId && activeTransports.has(sessionId)) {
            transport = activeTransports.get(sessionId);
        } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
            const authHeader = req.headers.authorization;
            const queryKey = req.query.key;
            const serviceKey = (authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : null) || queryKey;

            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessioninitialized: (sid) => {
                    activeTransports.set(sid, transport);
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && activeTransports.has(sid)) {
                    activeTransports.delete(sid);
                }
            };

            const serverInstance = createMcpServerInstance(serviceKey);
            await serverInstance.connect(transport);
        } else {
            return res.status(400).json({
                jsonrpc: "2.0",
                error: { code: -32000, message: "No valid session ID provided or server uninitialized." },
                id: null
            });
        }

        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        console.error('[MCP Streamable] Request error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
};

app.post('/sse', handleStreamableHttp);
app.all('/mcp', handleStreamableHttp);

// 2. LEGACY HTTP+SSE TRANSPORT (Claude Desktop, Cursor, Legacy Clients)
app.get('/sse', async (req, res) => {
    const authHeader = req.headers.authorization;
    const queryKey = req.query.key;
    const serviceKey = (authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : null) || queryKey;

    const transport = new SSEServerTransport('/messages', res);
    activeTransports.set(transport.sessionId, transport);

    res.on('close', () => {
        activeTransports.delete(transport.sessionId);
        console.log(`[MCP SSE] Client disconnected: ${transport.sessionId}`);
    });

    const serverInstance = createMcpServerInstance(serviceKey);
    await serverInstance.connect(transport);
});

const handlePostMessages = async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = activeTransports.get(sessionId);
    if (!transport || !(transport instanceof SSEServerTransport)) {
        return res.status(404).json({ error: "Session not found or expired." });
    }
    await transport.handlePostMessage(req, res, req.body);
};

app.post('/messages', handlePostMessages);
app.post('/api/mcp/messages', handlePostMessages);

const server = app.listen(PORT, () => {
    console.log(`===========================================================`);
    console.log(`  ⚡ AGENTPAY PAYMENT GATEWAY RUNNING ON PORT ${PORT}`);
    console.log(`  • Default Agent Wallet: ${process.env.VOLTAGE_WALLET_ID}`);
    console.log(`  • MCP Gateway Route:    http://localhost:${PORT}/api/gateway/pay`);
    console.log(`  • Dashboard SSE:        http://localhost:${PORT}/api/stream`);
    console.log(`===========================================================`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ [ERROR] Port ${PORT} is already in use by another process!`);
        console.error(`👉 Run 'netstat -ano | findstr :${PORT}' or kill the background process using port ${PORT}.\n`);
    } else {
        console.error(`\n❌ [ERROR] Server error:`, err);
    }
});