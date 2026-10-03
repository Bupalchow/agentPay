# ⚡ AgentPay: Machine Money for Autonomous AI Agents

> **Native Bitcoin Lightning micropayments and zero-trust budget delegation for AI agents via MCP (Model Context Protocol).**

Autonomous software cannot get credit cards, bank accounts, or pass human KYC. **AgentPay** provides a decentralized, permissionless payment rail that lets AI agents pay for APIs, tools, and compute per request using Bitcoin Lightning and L402 HTTP micropayments—with hard spending limits set by the user.

---

## 🌐 Live Deployments (No Setup Required to Test!)

Judges can explore the live system immediately without compiling anything locally:

- **🖥️ Live Demo Merchant (L402 Paywalled Resource):** [https://merchant-peach.vercel.app](https://merchant-peach.vercel.app)
  - Paywalled Endpoint (Mutinynet): `https://merchant-peach.vercel.app/api/data`
  - Paywalled Endpoint (NWC Mainnet): `https://merchant-peach.vercel.app/api/data/nwc`
- **⚙️ Live Gateway & MCP Server:** [https://agentpay-mtca.onrender.com](https://agentpay-mtca.onrender.com)
  - MCP SSE Endpoint: `https://agentpay-mtca.onrender.com/sse`
  - Health & Metadata: `https://agentpay-mtca.onrender.com/health`

---

## 🧪 Quickstart: Test Locally in 3 Steps

If you want to test the full stack on your local machine:

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/Bupalchow/agentPay.git
cd agentPay

# Install server dependencies
cd server && npm install

# Install dashboard dependencies
cd ../dashboard && npm install
```

### 2. Start the Gateway Server

```bash
cd server
npm start
```
> The gateway server runs at `http://localhost:3000`. It exposes the REST API, SSE live event stream, and remote MCP server (`/sse`).

### 3. Start the Developer Dashboard

In a new terminal:
```bash
cd dashboard
npm run dev
```
> Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 🚀 How to Test the Agent Payment Flow

You **do not need to run a local merchant server**—the live merchant is hosted 24/7 at `https://merchant-peach.vercel.app`.

### Option A: Interactive Test via Dashboard
1. Open the Dashboard at [http://localhost:5173](http://localhost:5173).
2. Sign in or connect your wallet via **Nostr Wallet Connect (NWC)** or use the built-in Voltage testnet faucet.
3. Click **"Generate Agent Key"** and give your agent a spending limit (e.g. `100 sats`).
4. Copy the generated `ap_live_...` key.

### Option B: Test with any MCP-Compatible AI Agent (Cursor / Claude Desktop)
Add the AgentPay MCP server to your `claude_desktop_config.json` or Cursor MCP settings:

```json
{
  "mcpServers": {
    "agentpay": {
      "url": "https://agentpay-mtca.onrender.com/sse",
      "headers": {
        "Authorization": "Bearer YOUR_AGENT_KEY"
      }
    }
  }
}
```

Now prompt your agent:
> *"Fetch the latest market data from `https://merchant-peach.vercel.app/api/data` using your L402 payment tool."*

**What happens behind the scenes:**
1. The AI agent makes an HTTP request to `https://merchant-peach.vercel.app/api/data`.
2. The merchant server returns **HTTP 402 Payment Required** with a BOLT11 Lightning invoice and macaroon.
3. The AI agent invokes `fetch_with_l402` or `pay_lightning_invoice` via MCP.
4. AgentPay checks that the invoice amount (10 sats) is within the agent's spending limit.
5. The invoice is settled over the Lightning Network in milliseconds.
6. The agent presents the payment preimage and receives the decrypted, premium API response!
7. The payment appears in real-time on your Mission Control Dashboard.

---

## 🛠️ Architecture Overview

```
                               ┌─────────────────────────────┐
                               │   AI Agent (Claude / Cursor)│
                               └──────────────┬──────────────┘
                                              │ MCP Tools (JSON-RPC over SSE)
                                              ▼
┌──────────────────────────────┐        ┌─────────────────────────────┐
│  Decentralized Nostr Relays  │◄──────►│       AgentPay Gateway      │
│     (NWC / NIP-47 Wallet)    │        │  (Spend Guard & Auth Proxy) │
└──────────────────────────────┘        └──────────────┬──────────────┘
                                                       │ L402 Settlement
                                                       ▼
                                        ┌─────────────────────────────┐
                                        │    Live Merchant Service    │
                                        │ (merchant-peach.vercel.app) │
                                        └─────────────────────────────┘
```

- **`server/`**: Express + Model Context Protocol (MCP) server managing agent keys, budget firewalls, and Lightning payment routing.
- **`dashboard/`**: React + Vite UI providing real-time audit logs, agent spend management, and wallet connection.
- **`merchant/`**: Independent L402 paywall service deployed on Vercel at `https://merchant-peach.vercel.app`.

---

## 🏆 Hackathon Tracks

- **Machine Money ($1,000):** Enables autonomous AI agents to hold, manage, and spend native Bitcoin over the Lightning Network without human permission, KYC, or credit cards.
- **Freedom Stack ($1,000):** Integrates **Nostr Wallet Connect (NWC / NIP-47)** over decentralized Nostr relays, ensuring users retain sovereign, non-custodial control over their funds.

---

## 📜 License
MIT License. Built for the Hackathon.
