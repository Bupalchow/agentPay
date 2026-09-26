const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env'), quiet: true });
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const axios = require('axios');
const crypto = require('crypto');

const server = new Server({
    name: "tollgate-l402-wallet",
    version: "2.0.0"
}, {
    capabilities: { tools: {} }
});

// ── Voltage helpers ──
const VOLTAGE_BASE = `https://voltageapi.com/v1/organizations/${process.env.VOLTAGE_ORG_ID}/environments/${process.env.VOLTAGE_ENV_ID}/payments`;
const VOLTAGE_HEADERS = { 'x-api-key': process.env.VOLTAGE_API_KEY, 'Content-Type': 'application/json' };

async function payInvoice(invoice) {
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
        if (status === 'completed') return;
        if (status === 'failed') throw new Error("Lightning payment failed to route.");
    }
    throw new Error("Payment timed out.");
}

// ── 1. Register tools ──
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "pay_lightning_invoice",
            description: "Pays a Lightning Network BOLT11 invoice and retrieves the L402 preimage receipt. Returns the verified preimage and the exact Authorization header format to retry the request.",
            inputSchema: {
                type: "object",
                properties: {
                    invoice: { type: "string", description: "The lntb... or lnbc... invoice string" },
                    serverUrl: { type: "string", description: "Optional API server URL (default: http://localhost:3000)" }
                },
                required: ["invoice"]
            }
        },
        {
            name: "fetch_with_l402",
            description: [
                "Fetches data from any URL that may require Lightning payment.",
                "If the server returns HTTP 402 Payment Required, this tool automatically:",
                "  1. Extracts the Lightning invoice from the response",
                "  2. Pays the invoice using the configured wallet",
                "  3. Obtains the payment preimage (proof of payment)",
                "  4. Retries the request with the L402 Authorization header",
                "  5. Returns the final data",
                "",
                "Just pass a URL — the tool handles everything."
            ].join("\n"),
            inputSchema: {
                type: "object",
                properties: {
                    url:    { type: "string", description: "The URL to fetch (e.g. http://localhost:3000/api/data)" },
                    method: { type: "string", description: "HTTP method (default: GET)", enum: ["GET", "POST", "PUT", "DELETE"] },
                    body:   { type: "string", description: "Optional JSON body for POST/PUT requests" }
                },
                required: ["url"]
            }
        }
    ]
}));

// ── 2. Tool Handlers ──
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "pay_lightning_invoice") {
        const { invoice, serverUrl = "http://localhost:3000" } = request.params.arguments || {};
        if (!invoice) return fail("Missing required 'invoice' parameter.");
        try {
            await payInvoice(invoice);

            // Fetch the verified preimage from the server
            let preimage;
            for (let i = 0; i < 15; i++) {
                try {
                    const { data } = await axios.get(`${serverUrl}/api/preimage/${encodeURIComponent(invoice)}`);
                    if (data?.preimage) {
                        preimage = data.preimage;
                        break;
                    }
                } catch (e) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            if (preimage) {
                return ok(
                    `✅ Successfully paid Lightning invoice!\n\n` +
                    `Preimage: ${preimage}\n\n` +
                    `Now retry your request with this header:\n` +
                    `Authorization: L402 <macaroon>:${preimage}`
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

    const { url, method = "GET", body } = request.params.arguments;

    try {
        // ── First request ──
        let response;
        const requestData = body ? (typeof body === 'string' ? JSON.parse(body) : body) : undefined;
        try {
            response = await axios({ method, url, data: requestData });
        } catch (err) {
            if (!err.response || err.response.status !== 402) throw err;
            response = err.response;
        }

        // If it's not a 402, just return the data directly
        if (response.status !== 402) {
            return ok(`Status ${response.status}\n\n${JSON.stringify(response.data, null, 2)}`);
        }

        // ── Parse the L402 challenge ──
        const wwwAuth = response.headers['www-authenticate'];
        if (!wwwAuth) return fail("Got 402 but no WWW-Authenticate header.");

        const macaroon = wwwAuth.match(/macaroon="([^"]+)"/)?.[1];
        const invoice  = wwwAuth.match(/invoice="([^"]+)"/)?.[1];
        if (!macaroon || !invoice) return fail("Could not parse macaroon/invoice from WWW-Authenticate header.");

        // ── Pay the Lightning invoice ──
        await payInvoice(invoice);

        // ── Get the preimage from the server ──
        //    Decode the macaroon to find the paymentHash, then ask the server's /api/preimage endpoint.
        const origin = new URL(url).origin;
        const { MacaroonsBuilder } = require('macaroons.js');
        const mac = MacaroonsBuilder.deserialize(macaroon);
        const paymentHash = mac.identifier;

        let preimage;
        for (let i = 0; i < 10; i++) {
            try {
                const { data } = await axios.get(`${origin}/api/preimage/${paymentHash}`);
                preimage = data.preimage;
                break;
            } catch (err) {
                if (err.response?.status === 402) {
                    // Invoice not settled yet on the server side, wait and retry
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                throw err;
            }
        }

        if (!preimage) return fail("Paid the invoice but server has not confirmed settlement yet.");

        // ── Retry the original request with L402 credentials ──
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
server.connect(transport).then(() => console.error("Tollgate MCP Server v2 running."));