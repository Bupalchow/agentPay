#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env'), quiet: true });
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const axios = require('axios');
const crypto = require('crypto');

const server = new Server({
    name: "agentpay",
    version: "2.0.0"
}, {
    capabilities: { tools: {} }
});

// ── Gateway & Wallet Dispatcher ──
const AGENTPAY_GATEWAY_URL = process.env.AGENTPAY_GATEWAY_URL || 'http://localhost:3000';
const AGENTPAY_SERVICE_KEY = process.env.AGENTPAY_SERVICE_KEY;

// Direct Voltage fallback (for local standalone testing)
const VOLTAGE_BASE = process.env.VOLTAGE_ORG_ID ? `https://voltageapi.com/v1/organizations/${process.env.VOLTAGE_ORG_ID}/environments/${process.env.VOLTAGE_ENV_ID}/payments` : null;
const VOLTAGE_HEADERS = { 'x-api-key': process.env.VOLTAGE_API_KEY, 'Content-Type': 'application/json' };

async function payInvoice(invoice) {
    // 1. If running with an Agent Service Key (Multi-tenant Gateway mode)
    if (AGENTPAY_SERVICE_KEY) {
        try {
            const res = await axios.post(`${AGENTPAY_GATEWAY_URL}/api/gateway/pay`, { invoice }, {
                headers: {
                    'Authorization': `Bearer ${AGENTPAY_SERVICE_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });
            if (res.data?.success && res.data?.preimage) {
                return res.data.preimage;
            }
            throw new Error(res.data?.error || "Gateway did not return preimage.");
        } catch (err) {
            console.error("[AgentPay MCP] Gateway error:", err.response?.data?.error || err.message);
            throw new Error(err.response?.data?.error || err.message);
        }
    }

    // 2. Fallback to direct local Voltage credentials if configured
    if (VOLTAGE_BASE && process.env.VOLTAGE_WALLET_ID) {
        const id = crypto.randomUUID();
        await axios.post(VOLTAGE_BASE, {
            id,
            wallet_id: process.env.VOLTAGE_WALLET_ID,
            currency: 'btc',
            type: 'bolt11',
            data: { payment_request: invoice }
        }, { headers: VOLTAGE_HEADERS });

        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const { data } = await axios.get(`${VOLTAGE_BASE}/${id}`, { headers: VOLTAGE_HEADERS });
            const status = data.data?.status || data.status;
            if (status === 'completed') {
                const preimage = data.data?.payment_preimage
                    || data.payment_preimage
                    || data.data?.preimage
                    || data.preimage
                    || data.data?.outflows?.find(o => o.data?.preimage)?.data?.preimage
                    || data.outflows?.find(o => o.data?.preimage)?.data?.preimage;
                return preimage;
            }
            if (status === 'failed') throw new Error("Lightning payment failed to route.");
        }
        throw new Error("Payment timed out.");
    }

    throw new Error("No wallet configured. Please set AGENTPAY_SERVICE_KEY or local wallet credentials.");
}

// ── 1. Register tools ──
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "pay_lightning_invoice",
            description: "Pays a Lightning Network BOLT11 invoice and retrieves the L402 preimage receipt directly from the payment response. Returns the verified preimage and the exact Authorization header format to retry the request.",
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
            description: [
                "Fetches data from any URL requiring Lightning L402 payment.",
                "Can pay an existing invoice from a prior 402 challenge, or automatically discover, pay, and unlock.",
                "Options:",
                "  1. Just pass 'url': tool discovers 402, pays invoice, and unlocks data.",
                "  2. Pass 'url', 'invoice', and 'macaroon': pays existing invoice without duplicate requests.",
                "  3. Pass 'url', 'macaroon', and 'preimage': unlocks immediately if invoice was already paid."
            ].join("\n"),
            inputSchema: {
                type: "object",
                properties: {
                    url:      { type: "string", description: "The paywalled URL to access (e.g. http://localhost:3001/api/data)" },
                    method:   { type: "string", description: "HTTP method (default: GET)", enum: ["GET", "POST", "PUT", "DELETE"] },
                    body:     { type: "string", description: "Optional JSON body for POST/PUT requests" },
                    invoice:  { type: "string", description: "Optional BOLT11 invoice if already received from a prior 402 challenge" },
                    macaroon: { type: "string", description: "Optional L402 macaroon if already received from a prior 402 challenge" },
                    preimage: { type: "string", description: "Optional payment preimage if invoice was already paid via pay_lightning_invoice" }
                },
                required: ["url"]
            }
        }
    ]
}));

// ── 2. Tool Handlers ──
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "pay_lightning_invoice") {
        const { invoice } = request.params.arguments || {};
        if (!invoice) return fail("Missing required 'invoice' parameter.");
        try {
            const preimage = await payInvoice(invoice);

            if (preimage) {
                return ok(
                    `✅ Successfully paid Lightning invoice!\n\n` +
                    `Preimage: ${preimage}\n\n` +
                    `Now retry your request with this header:\n` +
                    `Authorization: L402 <macaroon>:${preimage}\n` +
                    `Or call fetch_with_l402 with { url, macaroon, preimage: "${preimage}" }`
                );
            }
            return ok(`Successfully paid Lightning invoice! Invoice: ${invoice.slice(0, 30)}...`);
        } catch (err) {
            return fail(`Payment failed: ${err.message}`);
        }
    }

    if (request.params.name !== "fetch_with_l402") {
        throw new Error("Unknown tool: " + request.params.name);
    }

    const { url, method = "GET", body, invoice: inputInvoice, macaroon: inputMacaroon, preimage: inputPreimage } = request.params.arguments || {};

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
                    return ok(`Status ${response.status}\n\n${JSON.stringify(response.data, null, 2)}`);
                }

                const wwwAuth = response.headers['www-authenticate'] || '';
                macaroon = macaroon || wwwAuth.match(/macaroon="([^"]+)"/)?.[1] || response.data?.macaroon;
                invoice = invoice || wwwAuth.match(/invoice="([^"]+)"/)?.[1] || response.data?.invoice;
                if (!macaroon || !invoice) {
                    return fail("Got 402 but could not parse macaroon or invoice from WWW-Authenticate or response body.");
                }
            }

            preimage = await payInvoice(invoice);
            if (!preimage) return fail("Payment completed but no preimage was returned.");
        }

        // Step 2: Retry request with L402 credentials
        const retryResponse = await axios({
            method, url,
            data: requestData,
            headers: { 'Authorization': `L402 ${macaroon}:${preimage}` }
        });

        return ok(
            `✅ Paid Lightning invoice & unlocked data!\n\n` +
            JSON.stringify(retryResponse.data, null, 2)
        );

    } catch (err) {
        return fail(err.response?.data ? JSON.stringify(err.response.data) : err.message);
    }
});

function ok(text)   { return { content: [{ type: "text", text }] }; }
function fail(text)  { return { content: [{ type: "text", text: `❌ ${text}` }], isError: true }; }

const transport = new StdioServerTransport();
server.connect(transport).then(() => console.error("AgentPay MCP Server running."));