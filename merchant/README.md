# 🛒 AgentPay Demo Merchant Service

This is an independent demo API server demonstrating **L402 (HTTP 402 Payment Required)** micropayments over the Bitcoin Lightning Network.

## 🌐 Live Merchant URL

The merchant is deployed live on Vercel and available 24/7:
**[https://merchant-peach.vercel.app](https://merchant-peach.vercel.app)**

> 💡 **Note:** You do not need to run this service locally. You can test directly against the live URL above.

---

## 📡 Available Endpoints

### 1. Root / Service Info
- **URL:** `GET https://merchant-peach.vercel.app/`
- **Description:** Returns service metadata, supported protocols, and dynamic paywall endpoints.

### 2. Mutinynet L402 Paywall
- **URL:** `GET https://merchant-peach.vercel.app/api/data`
- **Cost:** 10 satoshis
- **Behavior:**
  - Returns `402 Payment Required` with `WWW-Authenticate: L402 macaroon="...", invoice="..."` when called without credentials.
  - Returns premium financial market data when called with `Authorization: L402 <macaroon>:<preimage>`.

### 3. Nostr Wallet Connect (NWC) Mainnet Paywall
- **URL:** `GET https://merchant-peach.vercel.app/api/data/nwc`
- **Cost:** 10 satoshis
- **Behavior:** Issues a real-world Lightning invoice for any NIP-47 compatible Nostr wallet (e.g. Alby, Primal, Mutiny). Unlocks premium BTC market data upon cryptographic preimage verification.

### 4. Direct Invoice Generator
- **URL:** `GET / POST https://merchant-peach.vercel.app/api/invoice/nwc`
- **Parameters:** `amount` (default: 10), `description`
- **Returns:** BOLT11 invoice and payment hash for custom testing.
