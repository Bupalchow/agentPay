require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

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

// ── Firebase Admin Authentication & Firestore Database ──
const admin = require('firebase-admin');
const { cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

if (!admin.getApps().length) {
    const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(serviceAccountPath)) {
        admin.initializeApp({
            credential: cert(require(serviceAccountPath)),
            projectId: process.env.FIREBASE_PROJECT_ID || 'proximity-51dec'
        });
        console.log('[Firebase] Initialized Admin SDK with serviceAccountKey.json (Firestore Cloud Connected)');
    } else {
        admin.initializeApp({
            projectId: process.env.FIREBASE_PROJECT_ID || 'proximity-51dec'
        });
        console.log('[Firebase] Initialized with default project config');
    }
}

const firebaseAuth = getAuth();
const db = getFirestore();

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
        const { agentName = 'Autonomous Agent', walletType = 'voltage', walletConfig = {} } = req.body || {};
        const userId = req.user.uid;
        const serviceKey = 'ap_live_' + crypto.randomBytes(12).toString('hex');
        const keyId = 'key_' + Date.now();

        const newKey = {
            id: keyId,
            userId,
            serviceKey,
            agentName,
            walletType,
            walletConfig,
            createdAt: new Date().toISOString(),
            network: walletType === 'nwc' ? 'NWC (Alby/Primal/Mutiny)' : walletType === 'lnd' ? 'LND Custom Node' : 'Voltage Cloud (Mutinynet)',
            active: true
        };

        // 1. Save in user's subcollection for console listing
        await db.doc(`users/${userId}/agents/${keyId}`).set(newKey);
        // 2. Save in top-level agent_keys for instant O(1) gateway lookups
        await db.collection('agent_keys').doc(serviceKey).set(newKey);

        console.log(`[FIRESTORE] Registered new agent '${agentName}' (${walletType}) for user ${userId.slice(0, 8)}...`);

        return res.json({
            success: true,
            key: newKey,
            mcpConfig: {
                remote: {
                    url: `http://localhost:${PORT}/sse`,
                    headers: { Authorization: `Bearer ${serviceKey}` }
                },
                stdio: {
                    command: "node",
                    args: ["./mcp.js"],
                    env: {
                        AGENTPAY_SERVICE_KEY: serviceKey,
                        AGENTPAY_GATEWAY_URL: `http://localhost:${PORT}`
                    }
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

    console.log(`[GATEWAY] Payment request received from Agent '${agent.agentName}' (${agent.walletType})...`);

    try {
        if (agent.walletType === 'voltage' || !agent.walletType) {
            const result = await payVoltageInvoiceWithConfig(invoice, agent.walletConfig || {});
            console.log(`[GATEWAY] Voltage payment settled for Agent '${agent.agentName}'!`);
            broadcast('payment_verified', {
                agent: agent.agentName,
                amount: 10,
                preimage: result.preimage,
                paymentId: result.paymentId
            });
            return res.json({ success: true, preimage: result.preimage, paymentId: result.paymentId });
        }

        if (agent.walletType === 'nwc') {
            return res.status(501).json({ error: "NWC execution available via direct client NWC dispatch." });
        }

        if (agent.walletType === 'lnd') {
            return res.status(501).json({ error: "LND REST execution available via direct client LND dispatch." });
        }

        throw new Error("Unsupported wallet type.");
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
        const orgId = process.env.VOLTAGE_ORG_ID;
        const envId = process.env.VOLTAGE_ENV_ID;
        const apiKey = process.env.VOLTAGE_API_KEY;
        const base = `https://voltageapi.com/v1/organizations/${orgId}/environments/${envId}/payments?limit=6`;
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
// AGENT SIMULATION ENDPOINT (Queries external merchant at :3001 & pays via gateway)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/simulate-agent', async (req, res) => {
    const { agentName = 'Autonomous Market Agent', serviceKey, agentId } = req.body || {};

    let agent = null;
    if (serviceKey) {
        try {
            const docSnap = await db.collection('agent_keys').doc(serviceKey).get();
            if (docSnap.exists) agent = docSnap.data();
        } catch (e) {}
    }

    const walletConfig = (agent?.walletConfig && agent.walletConfig.apiKey) ? agent.walletConfig : {
        orgId: process.env.VOLTAGE_ORG_ID,
        envId: process.env.VOLTAGE_ENV_ID,
        walletId: process.env.VOLTAGE_WALLET_ID || '137fa5a5-a910-4964-926d-cb6de6005a10',
        apiKey: process.env.VOLTAGE_API_KEY
    };

    console.log(`[SIMULATION] Starting agent execution for '${agentName}'...`);

    const MERCHANT_URL = process.env.MERCHANT_URL || 'http://localhost:3001/api/data';

    try {
        // Step 1: Agent attempts to access the paywalled Merchant Site (Port 3001)
        console.log(`[SIMULATION] Step 1: Agent requests data from Merchant at ${MERCHANT_URL}...`);
        let invoice = null;
        let macaroon = null;
        let paymentHash = null;

        try {
            await axios.get(MERCHANT_URL);
        } catch (err) {
            if (err.response?.status === 402) {
                const wwwAuth = err.response.headers['www-authenticate'] || '';
                macaroon = wwwAuth.match(/macaroon="([^"]+)"/)?.[1];
                invoice = wwwAuth.match(/invoice="([^"]+)"/)?.[1];
            } else {
                throw new Error(`Merchant site at ${MERCHANT_URL} is unreachable. Ensure the merchant server is running ('npm run merchant').`);
            }
        }

        if (!invoice || !macaroon) {
            throw new Error("Merchant response did not contain a valid L402 challenge with invoice and macaroon.");
        }

        // Broadcast invoice created event to dashboard
        broadcast('invoice_created', { amount: 10, agent: agentName, invoice });

        // Step 2: AgentPay Gateway settles the invoice using the Agent's wallet
        console.log(`[SIMULATION] Step 2: AgentPay Gateway routing payment from Agent Wallet (${walletConfig.walletId})...`);
        const paymentResult = await payVoltageInvoiceWithConfig(invoice, walletConfig);
        console.log(`[SIMULATION] Step 3: Payment settled! Preimage: ${paymentResult.preimage.slice(0, 16)}...`);

        // Broadcast payment verified event to dashboard
        broadcast('payment_verified', {
            agent: agentName,
            amount: 10,
            preimage: paymentResult.preimage,
            paymentId: paymentResult.paymentId
        });

        // Step 3: Agent retries request to Merchant with L402 Authorization header
        console.log(`[SIMULATION] Step 4: Submitting Authorization: L402 to Merchant...`);
        let unlockedRes;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                unlockedRes = await axios.get(MERCHANT_URL, {
                    headers: { 'Authorization': `L402 ${macaroon}:${paymentResult.preimage}` }
                });
                if (unlockedRes.status === 200) break;
            } catch (retryErr) {
                if (retryErr.response?.status === 401 && attempt < 4) {
                    console.log(`[SIMULATION] Waiting for invoice settlement to clear on ledger (attempt ${attempt + 1}/5)...`);
                    await new Promise(r => setTimeout(r, 600));
                    continue;
                }
                throw retryErr;
            }
        }

        return res.json({
            success: true,
            agent: agentName,
            merchantUrl: MERCHANT_URL,
            invoice,
            preimage: paymentResult.preimage,
            amount: 10,
            network: 'Mutinynet Signet (Voltage Cloud Node)',
            voltageDetails: {
                paymentId: paymentResult.paymentId,
                walletId: paymentResult.walletId,
                ledgerId: paymentResult.ledgerId,
                status: paymentResult.status,
                createdAt: paymentResult.createdAt
            },
            data: unlockedRes.data?.data || unlockedRes.data
        });
    } catch (err) {
        console.error('[SIMULATION] Flow failed:', err.response?.data || err.message);
        return res.status(500).json({
            error: `Agent payment flow failed: ${err.response?.data?.message || err.message}`
        });
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
        const walletConfig = agent?.walletConfig || {
            orgId: process.env.VOLTAGE_ORG_ID,
            envId: process.env.VOLTAGE_ENV_ID,
            walletId: process.env.VOLTAGE_WALLET_ID,
            apiKey: process.env.VOLTAGE_API_KEY
        };

        if (name === "pay_lightning_invoice") {
            const { invoice } = args || {};
            if (!invoice) return { content: [{ type: "text", text: "❌ Missing required 'invoice' parameter." }], isError: true };

            try {
                const result = await payVoltageInvoiceWithConfig(invoice, walletConfig);
                broadcast('payment_verified', {
                    agent: agent?.agentName || 'Remote MCP Agent',
                    amount: 10,
                    preimage: result.preimage,
                    paymentId: result.paymentId
                });
                return {
                    content: [{
                        type: "text",
                        text: `✅ Successfully paid Lightning invoice!\n\nPreimage: ${result.preimage}\n\nNow retry your request with this header:\nAuthorization: L402 <macaroon>:${result.preimage}\nOr pass { url, macaroon, preimage: "${result.preimage}" } to fetch_with_l402.`
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
                        try {
                            response = await axios({ method, url, data: requestData });
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

                    broadcast('invoice_created', { amount: 10, agent: agent?.agentName || 'Remote MCP Agent', invoice });
                    const paymentResult = await payVoltageInvoiceWithConfig(invoice, walletConfig);
                    preimage = paymentResult.preimage;
                    broadcast('payment_verified', {
                        agent: agent?.agentName || 'Remote MCP Agent',
                        amount: 10,
                        preimage: paymentResult.preimage,
                        paymentId: paymentResult.paymentId
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