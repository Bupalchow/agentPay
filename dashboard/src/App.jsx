import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Check, Copy, RefreshCw, Circle, ArrowRight, 
  User, LogOut, Lock, Key, AlertCircle, Shield, Zap
} from 'lucide-react';
import { 
  auth, 
  db,
  isConfigured as isFirebaseConfigured, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  collection,
  doc,
  setDoc,
  getDocs
} from './firebase';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

export default function App() {
  // ── Authentication & Protected Route State ──
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState('signin'); // 'signin' | 'signup'
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);

  // ── Navigation (2 Pages, protected) ──
  const [currentPage, setCurrentPage] = useState('integration'); // 'integration' | 'simulation'

  // ── Shared SSE & UI State ──
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [copied, setCopied] = useState(null);

  // ── Integration Page State ──
  const [mcpClient, setMcpClient] = useState('claude'); // 'claude' | 'cursor' | 'python' | 'curl'
  const [walletType, setWalletType] = useState('voltage'); // 'voltage' | 'nwc' | 'lnd'
  const [newKeyName, setNewKeyName] = useState('');
  
  // Wallet Credentials Form States
  const [voltageApiKey, setVoltageApiKey] = useState('');
  const [voltageOrgId, setVoltageOrgId] = useState('');
  const [voltageEnvId, setVoltageEnvId] = useState('');
  const [voltageWalletId, setVoltageWalletId] = useState('');
  const [nwcUri, setNwcUri] = useState('');
  const [lndRestUrl, setLndRestUrl] = useState('');
  const [lndMacaroon, setLndMacaroon] = useState('');

  const [keyList, setKeyList] = useState([]);
  const [activeKey, setActiveKey] = useState(null);
  const [isCreatingKey, setIsCreatingKey] = useState(false);
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [quickTestResult, setQuickTestResult] = useState(null);
  const [isTestingEndpoint, setIsTestingEndpoint] = useState(false);

  // ── Simulation Page State ──
  const [totalSats, setTotalSats] = useState(0);
  const [settledCount, setSettledCount] = useState(0);
  const [activeSessions, setActiveSessions] = useState(0);
  const [status, setStatus] = useState('idle'); // 'idle' | 'pending' | 'verified'
  const [events, setEvents] = useState([]);
  const [isSimulating, setIsSimulating] = useState(false);
  const [simStep, setSimStep] = useState(0); // 0: idle, 1: req, 2: 402, 3: paying, 4: done
  const [simData, setSimData] = useState(null);
  const [simDetails, setSimDetails] = useState(null);
  const [simError, setSimError] = useState(null);
  const [walletHistory, setWalletHistory] = useState([]);
  const [walletId, setWalletId] = useState(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const feedRef = useRef(null);
  const statusTimer = useRef(null);

  // ── Load User's Registered Agents from Backend & Firestore ──
  const loadUserAgents = async (currentUser) => {
    if (!currentUser) {
      setKeyList([]);
      setActiveKey(null);
      return;
    }

    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch(`${API_BASE}/api/keys`, {
        headers: {
          'Authorization': `Bearer ${idToken}`
        }
      });
      const d = await res.json();
      if (d.success && Array.isArray(d.keys)) {
        setKeyList(d.keys);
        if (d.keys.length > 0) {
          setActiveKey(d.keys[0]);
        } else {
          setActiveKey(null);
        }
      }
    } catch (err) {
      console.error("[AgentPay] Error loading keys from API:", err);
    }

    // Sync from Firestore if available
    if (db && currentUser) {
      try {
        const snap = await getDocs(collection(db, "users", currentUser.uid, "agents"));
        const fsAgents = [];
        snap.forEach((d) => fsAgents.push({ id: d.id, ...d.data() }));
        if (fsAgents.length > 0) {
          setKeyList((prev) => {
            if (prev.length === 0) {
              setActiveKey(fsAgents[0]);
              return fsAgents;
            }
            return prev;
          });
        }
      } catch (fsErr) {
        console.warn("[AgentPay] Firestore read note:", fsErr.message);
      }
    }
  };

  // ── Monitor Firebase Auth State ──
  useEffect(() => {
    if (auth) {
      const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
        setUser(currentUser);
        setAuthLoading(false);
        if (currentUser) {
          await loadUserAgents(currentUser);
        } else {
          setKeyList([]);
          setActiveKey(null);
        }
      });
      return () => unsubscribe();
    } else {
      setAuthLoading(false);
    }
  }, []);

  // ── Native SSE Stream (Only connect when authenticated) ──
  useEffect(() => {
    if (!user) return;

    const es = new EventSource(`${API_BASE}/api/stream`);

    es.onopen = () => setConnectionStatus('connected');
    es.onerror = () => setConnectionStatus('disconnected');

    es.addEventListener('invoice_created', (e) => {
      try {
        const data = JSON.parse(e.data);
        setStatus('pending');
        setActiveSessions((prev) => prev + 1);

        if (statusTimer.current) clearTimeout(statusTimer.current);

        setEvents((prev) => [
          {
            id: Date.now() + Math.random(),
            type: 'invoice_created',
            title: 'HTTP 402 Challenge Issued',
            detail: `10 sat Lightning invoice generated for ${data.agent || 'Agent'}`,
            hash: data.paymentHash,
            amount: data.amount || 10,
            time: new Date().toLocaleTimeString()
          },
          ...prev
        ]);
      } catch (err) {
        console.error('[SSE] Error handling invoice_created:', err);
      }
    });

    es.addEventListener('payment_verified', (e) => {
      try {
        const data = JSON.parse(e.data);
        setTotalSats((prev) => prev + 10);
        setSettledCount((prev) => prev + 1);
        setActiveSessions((prev) => Math.max(0, prev - 1));
        setStatus('verified');

        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(() => setStatus('idle'), 4000);

        setEvents((prev) => [
          {
            id: Date.now() + Math.random(),
            type: 'payment_verified',
            title: 'Lightning Payment Settled',
            detail: `Preimage verified for ${data.agent || 'Agent'} -> HTTP 200 Unlocked`,
            hash: data.paymentHash,
            amount: 10,
            time: new Date().toLocaleTimeString()
          },
          ...prev
        ]);
      } catch (err) {
        console.error('[SSE] Error handling payment_verified:', err);
      }
    });

    return () => {
      es.close();
      if (statusTimer.current) clearTimeout(statusTimer.current);
    };
  }, [user]);

  const copyToClipboard = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1600);
  };

  // ── Fetch Live Wallet Ledger & Transactions from Voltage Node ──
  const fetchWalletHistory = async () => {
    setIsLoadingHistory(true);
    try {
      const res = await fetch(`${API_BASE}/api/wallet/recent-payments`);
      const data = await res.json();
      if (data.success) {
        setWalletHistory(data.items || []);
        if (data.walletId) setWalletId(data.walletId);
      }
    } catch (err) {
      console.error('[AgentPay] Failed to fetch wallet history:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  // Load wallet history on auth or when switching to simulation tab
  useEffect(() => {
    if (user && currentPage === 'simulation') {
      fetchWalletHistory();
    }
  }, [user, currentPage]);

  // ── Handle Firebase Auth Form Submit ──
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthSubmitting(true);

    if (!auth || !isFirebaseConfigured) {
      setAuthError('Firebase credentials not detected in .env.');
      setAuthSubmitting(false);
      return;
    }

    try {
      if (authMode === 'signup') {
        await createUserWithEmailAndPassword(auth, authEmail, authPassword);
      } else {
        await signInWithEmailAndPassword(auth, authEmail, authPassword);
      }
      setAuthEmail('');
      setAuthPassword('');
    } catch (err) {
      setAuthError(err.message.replace('Firebase: ', ''));
    } finally {
      setAuthSubmitting(false);
    }
  };

  // ── Handle Logout ──
  const handleLogout = async () => {
    if (auth) {
      try { await signOut(auth); } catch (e) {}
    }
    setUser(null);
    setKeyList([]);
    setActiveKey(null);
  };

  // ── Provision New Agent Service Key With Wallet Credentials ──
  const handleCreateKey = async (e) => {
    e.preventDefault();
    if (!newKeyName.trim() || !user) return;
    setIsSavingKey(true);

    let walletConfig = {};
    if (walletType === 'voltage') {
      walletConfig = {
        apiKey: voltageApiKey,
        orgId: voltageOrgId,
        envId: voltageEnvId,
        walletId: voltageWalletId
      };
    } else if (walletType === 'nwc') {
      walletConfig = { nwcUri };
    } else {
      walletConfig = { restUrl: lndRestUrl, macaroon: lndMacaroon };
    }

    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${API_BASE}/api/keys`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({ 
          agentName: newKeyName, 
          walletType, 
          walletConfig 
        })
      });

      const d = await res.json();
      if (d.success) {
        // Also persist agent record to Firestore
        if (db) {
          try {
            await setDoc(doc(db, "users", user.uid, "agents", d.key.id), {
              agentName: newKeyName,
              walletType,
              serviceKey: d.key.serviceKey,
              createdAt: new Date().toISOString()
            });
          } catch (fsErr) {
            console.warn("[AgentPay] Firestore write note:", fsErr.message);
          }
        }

        setKeyList((prev) => [d.key, ...prev]);
        setActiveKey(d.key);
        setNewKeyName('');
        setVoltageApiKey('');
        setVoltageOrgId('');
        setVoltageEnvId('');
        setVoltageWalletId('');
        setNwcUri('');
        setLndRestUrl('');
        setLndMacaroon('');
        setIsCreatingKey(false);
      } else {
        alert(d.error || "Failed to register agent wallet.");
      }
    } catch (err) {
      console.error('Failed to create key:', err);
      alert('Error registering wallet: ' + err.message);
    } finally {
      setIsSavingKey(false);
    }
  };

  // ── Quick Test 402 Endpoint ──
  const handleTestEndpoint = async () => {
    setIsTestingEndpoint(true);
    setQuickTestResult(null);

    try {
      const res = await fetch(`${API_BASE}/api/data`);
      const authHeader = res.headers.get('WWW-Authenticate') || '';

      setQuickTestResult({
        status: res.status,
        message: res.status === 402 
          ? 'Endpoint correctly returned HTTP 402 with BOLT11 invoice and macaroon.' 
          : 'Unexpected status code received.',
        authHeaderPreview: authHeader ? authHeader.slice(0, 70) + '...' : 'none'
      });
    } catch (err) {
      setQuickTestResult({
        status: 0,
        message: `Could not connect to ${API_BASE}. Ensure proxy is running.`
      });
    } finally {
      setIsTestingEndpoint(false);
    }
  };

  // ── Run End-to-End Simulation (Real Lightning Payment on Voltage) ──
  const runSimulation = async () => {
    if (isSimulating) return;
    setIsSimulating(true);
    setSimStep(1);
    setSimData(null);
    setSimDetails(null);
    setSimError(null);

    const targetAgentName = activeKey?.agentName || 'Voltage Mutinynet Agent';
    const targetServiceKey = activeKey?.serviceKey || null;
    const targetAgentId = activeKey?.id || null;

    try {
      await new Promise((r) => setTimeout(r, 350));
      setSimStep(2);

      const res = await fetch(`${API_BASE}/api/simulate-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          agentName: targetAgentName,
          serviceKey: targetServiceKey,
          agentId: targetAgentId
        })
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Real Lightning payment execution failed on Voltage.');
      }

      setSimStep(3);
      await new Promise((r) => setTimeout(r, 450));

      setSimStep(4);
      setSimData(data.data);
      setSimDetails({
        invoice: data.invoice,
        paymentHash: data.paymentHash,
        preimage: data.preimage,
        amount: data.amount || 10,
        settlement: data.settlement,
        network: data.network || 'Mutinynet Signet',
        voltageDetails: data.voltageDetails || null,
        agent: data.agent
      });

      // Automatically refresh wallet payments ledger from Voltage to show the new outflow!
      await fetchWalletHistory();
    } catch (err) {
      console.error('Simulation failed:', err);
      setSimError(err.message);
      setSimStep(0);
    } finally {
      setIsSimulating(false);
    }
  };

  const currentKeyString = activeKey?.serviceKey || '<register-an-agent-to-generate-key>';
  const serverPath = 'd:/helping others/agentPay/mcp.js';

  const getSnippet = () => {
    switch (mcpClient) {
      case 'claude':
        return JSON.stringify(
          {
            mcpServers: {
              "agentpay": {
                command: "node",
                args: [serverPath],
                env: {
                  AGENTPAY_SERVICE_KEY: currentKeyString,
                  AGENTPAY_GATEWAY_URL: API_BASE
                }
              }
            }
          },
          null,
          2
        );
      case 'cursor':
        return JSON.stringify(
          {
            mcpServers: {
              "agentpay": {
                command: "node",
                args: [serverPath],
                env: {
                  AGENTPAY_SERVICE_KEY: currentKeyString,
                  AGENTPAY_GATEWAY_URL: API_BASE
                }
              }
            }
          },
          null,
          2
        );
      case 'python':
        return `# Python (LangChain / CrewAI / Smolagents)
from langchain.agents import initialize_agent

# Call AgentPay tool directly when agent hits paywall:
response = agent.run(
    "Query restricted resource at ${API_BASE}/api/data "
    "using tool 'fetch_with_l402'."
)
print(response)  # AgentPay gateway settles invoice via ${activeKey ? activeKey.agentName : 'your wallet'}`;
      case 'curl':
        return `# 1. Query paywalled resource
curl -i ${API_BASE}/api/data

# Expected response:
# HTTP/1.1 402 Payment Required
# WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."

# 2. Direct payment via AgentPay gateway
curl -X POST ${API_BASE}/api/gateway/pay \\
  -H "Authorization: Bearer ${currentKeyString}" \\
  -H "Content-Type: application/json" \\
  -d '{"invoice": "<invoice>"}'`;
      default:
        return '';
    }
  };

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1. LOADING SCREEN (Checking Auth)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#090a0c] text-zinc-400 flex items-center justify-center font-mono text-xs">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 animate-spin text-zinc-300" />
          <span>Authenticating Developer Session...</span>
        </div>
      </div>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2. UNPROTECTED / AUTHENTICATION GATE (When NOT logged in)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (!user) {
    return (
      <div className="min-h-screen bg-[#090a0c] text-zinc-200 font-sans flex flex-col justify-center items-center p-4">
        <div className="w-full max-w-sm space-y-6">
          
          <div className="text-center space-y-1.5">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              <span>Production L402 Gateway</span>
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white">AgentPay Console</h1>
            <p className="text-xs text-zinc-400">
              Sign in with your developer account to manage autonomous agent wallets and keys.
            </p>
          </div>

          <div className="bg-zinc-900/70 border border-zinc-800 rounded-lg p-6 space-y-4 shadow-xl">
            {/* Mode Switcher */}
            <div className="flex bg-zinc-950 p-1 rounded border border-zinc-800 text-xs font-medium">
              <button
                type="button"
                onClick={() => { setAuthMode('signin'); setAuthError(''); }}
                className={`flex-1 py-1.5 rounded transition ${
                  authMode === 'signin' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => { setAuthMode('signup'); setAuthError(''); }}
                className={`flex-1 py-1.5 rounded transition ${
                  authMode === 'signup' ? 'bg-zinc-800 text-white font-semibold' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Create Account
              </button>
            </div>

            {authError && (
              <div className="p-2.5 rounded bg-red-950/40 border border-red-800 text-red-300 text-xs flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-400" />
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="space-y-3.5">
              <div>
                <label className="block text-[11px] font-mono text-zinc-400 mb-1">Developer Email</label>
                <input
                  type="email"
                  required
                  placeholder="developer@example.com"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-zinc-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-[11px] font-mono text-zinc-400 mb-1">Password</label>
                <input
                  type="password"
                  required
                  placeholder="••••••••"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-zinc-500 font-mono"
                />
              </div>

              <button
                type="submit"
                disabled={authSubmitting}
                className="w-full py-2.5 rounded bg-white text-black font-semibold text-xs hover:bg-zinc-200 transition flex items-center justify-center gap-2"
              >
                {authSubmitting ? (
                  <>
                    <RefreshCw className="h-3 w-3 animate-spin" />
                    <span>Authenticating...</span>
                  </>
                ) : (
                  <span>{authMode === 'signin' ? 'Sign In to Console' : 'Create Developer Account'}</span>
                )}
              </button>
            </form>
          </div>

          <div className="text-center text-[11px] font-mono text-zinc-500">
            Protected by Firebase Auth & Firestore
          </div>

        </div>
      </div>
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3. PROTECTED DEVELOPER DASHBOARD (Rendered ONLY when logged in)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  return (
    <div className="min-h-screen bg-[#090a0c] text-zinc-200 font-sans p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      
      {/* ── Top Bar: Authenticated Header ── */}
      <header className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-zinc-800/80 gap-3">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-white tracking-tight text-base">AgentPay</span>
          <span className="text-zinc-600 font-mono text-xs">/</span>
          <span className="text-xs text-zinc-400 font-mono">Developer Console</span>
        </div>

        <div className="flex items-center gap-3">
          {/* Navigation Tabs */}
          <nav className="flex items-center bg-zinc-900 border border-zinc-800 rounded p-1 text-xs font-medium">
            <button
              onClick={() => setCurrentPage('integration')}
              className={`px-3 py-1.5 rounded transition ${
                currentPage === 'integration'
                  ? 'bg-zinc-700 text-white font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Integration
            </button>
            <button
              onClick={() => setCurrentPage('simulation')}
              className={`px-3 py-1.5 rounded transition ${
                currentPage === 'simulation'
                  ? 'bg-zinc-700 text-white font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Simulation
            </button>
          </nav>

          {/* User Account & Sign Out */}
          <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 px-2.5 py-1.5 rounded text-xs">
            <User className="h-3 w-3 text-zinc-400" />
            <span className="text-zinc-300 font-mono max-w-[140px] truncate">{user.email}</span>
            <button
              onClick={handleLogout}
              title="Sign Out"
              className="text-zinc-500 hover:text-red-400 ml-1 transition"
            >
              <LogOut className="h-3 w-3" />
            </button>
          </div>

          {/* SSE Connection Status */}
          <div className="flex items-center gap-2 text-xs font-mono px-2.5 py-1.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
            <span
              className={`h-2 w-2 rounded-full ${
                connectionStatus === 'connected' ? 'bg-emerald-500' : 'bg-red-500'
              }`}
            />
            <span className="hidden sm:inline">
              {connectionStatus === 'connected' ? 'Live' : 'Offline'}
            </span>
          </div>
        </div>
      </header>

      {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          PAGE 1: INTEGRATION (MAIN FOCUS)
         ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {currentPage === 'integration' && (
        <main className="space-y-6">

          {/* Section 1: Agent Key & Wallet Setup */}
          <section className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-zinc-800/80 gap-2">
              <div>
                <h2 className="text-sm font-semibold text-white">Agent Service Key & Wallet Setup</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Link your Lightning wallet. Each registered agent gets a scoped Service Key for autonomous payments.
                </p>
              </div>

              <button
                onClick={() => setIsCreatingKey(!isCreatingKey)}
                className="self-start sm:self-auto text-xs font-medium px-3 py-1.5 rounded bg-white text-black hover:bg-zinc-200 transition"
              >
                {isCreatingKey ? 'Cancel' : '+ Register New Agent Wallet'}
              </button>
            </div>

            {/* Expandable Key & Wallet Creation Form */}
            {isCreatingKey && (
              <form onSubmit={handleCreateKey} className="p-4 rounded bg-zinc-950 border border-zinc-800 space-y-3">
                <div className="text-xs font-semibold text-white">Register Autonomous Agent Wallet</div>
                
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-mono text-zinc-400 mb-1">Agent Identifier Name</label>
                    <input
                      type="text"
                      placeholder="e.g. Market-Analysis-Bot"
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none font-mono"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-mono text-zinc-400 mb-1">Wallet Backend</label>
                    <select
                      value={walletType}
                      onChange={(e) => setWalletType(e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none font-mono"
                    >
                      <option value="voltage">Voltage (Mutinynet Signet)</option>
                      <option value="nwc">Nostr Wallet Connect (NWC)</option>
                      <option value="lnd">Custom LND Node</option>
                    </select>
                  </div>
                </div>

                {/* Conditional Fields based on Wallet Provider */}
                {walletType === 'voltage' && (
                  <div className="p-3 rounded bg-zinc-900/80 border border-zinc-800 space-y-2.5">
                    <span className="text-[11px] font-mono text-zinc-300 font-semibold block">Voltage Cloud Credentials</span>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                      <div>
                        <label className="block text-[10px] font-mono text-zinc-400 mb-0.5">API Key (x-api-key)</label>
                        <input
                          type="password"
                          placeholder="vltg_..."
                          value={voltageApiKey}
                          onChange={(e) => setVoltageApiKey(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 font-mono text-xs text-zinc-200"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-mono text-zinc-400 mb-0.5">Wallet ID</label>
                        <input
                          type="text"
                          placeholder="Wallet UUID"
                          value={voltageWalletId}
                          onChange={(e) => setVoltageWalletId(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 font-mono text-xs text-zinc-200"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-mono text-zinc-400 mb-0.5">Organization ID</label>
                        <input
                          type="text"
                          placeholder="Org UUID"
                          value={voltageOrgId}
                          onChange={(e) => setVoltageOrgId(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 font-mono text-xs text-zinc-200"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-mono text-zinc-400 mb-0.5">Environment ID</label>
                        <input
                          type="text"
                          placeholder="Environment UUID"
                          value={voltageEnvId}
                          onChange={(e) => setVoltageEnvId(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 font-mono text-xs text-zinc-200"
                          required
                        />
                      </div>
                    </div>
                  </div>
                )}

                {walletType === 'nwc' && (
                  <div className="p-3 rounded bg-zinc-900/80 border border-zinc-800 space-y-2">
                    <span className="text-[11px] font-mono text-zinc-300 font-semibold block">Nostr Wallet Connect URI</span>
                    <p className="text-[10px] text-zinc-400">
                      Exported from Alby, Primal, Mutiny, or Cashu with custom spending limits.
                    </p>
                    <input
                      type="password"
                      placeholder="nostr+walletconnect://..."
                      value={nwcUri}
                      onChange={(e) => setNwcUri(e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-700 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-200"
                      required
                    />
                  </div>
                )}

                {walletType === 'lnd' && (
                  <div className="p-3 rounded bg-zinc-900/80 border border-zinc-800 space-y-2">
                    <span className="text-[11px] font-mono text-zinc-300 font-semibold block">Custom LND REST Node</span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                      <div>
                        <label className="block text-[10px] font-mono text-zinc-400 mb-0.5">REST URL</label>
                        <input
                          type="text"
                          placeholder="https://node.domain.com:8080"
                          value={lndRestUrl}
                          onChange={(e) => setLndRestUrl(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 font-mono text-xs text-zinc-200"
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-mono text-zinc-400 mb-0.5">Payment Macaroon (Hex)</label>
                        <input
                          type="password"
                          placeholder="0201036c6e..."
                          value={lndMacaroon}
                          onChange={(e) => setLndMacaroon(e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1 font-mono text-xs text-zinc-200"
                          required
                        />
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex justify-end pt-1">
                  <button
                    type="submit"
                    disabled={isSavingKey}
                    className="px-4 py-2 rounded bg-white text-black font-semibold text-xs hover:bg-zinc-200 transition flex items-center gap-2"
                  >
                    {isSavingKey ? (
                      <>
                        <RefreshCw className="h-3 w-3 animate-spin" />
                        <span>Registering Wallet...</span>
                      </>
                    ) : (
                      <span>Save & Generate Agent Key</span>
                    )}
                  </button>
                </div>
              </form>
            )}

            {/* If NO agents registered yet: Clean Empty State */}
            {keyList.length === 0 ? (
              <div className="py-8 text-center space-y-3 bg-zinc-950/60 rounded border border-zinc-800/80 p-6">
                <div className="h-10 w-10 rounded-full bg-zinc-900 border border-zinc-800 mx-auto flex items-center justify-center text-zinc-400">
                  <Key className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">No Agent Wallets Connected</h3>
                  <p className="text-xs text-zinc-400 mt-1 max-w-md mx-auto">
                    You haven't registered any agent wallets yet. Connect a Voltage or NWC wallet to generate your first Agent Service Key.
                  </p>
                </div>
                <button
                  onClick={() => setIsCreatingKey(true)}
                  className="px-3.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition"
                >
                  Connect Your First Wallet
                </button>
              </div>
            ) : (
              /* Display Active Agent Key */
              <div className="space-y-3">
                <div className="p-3.5 rounded bg-zinc-950 border border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-zinc-500 uppercase">Active Agent:</span>
                      <span className="text-xs font-semibold text-white">{activeKey?.agentName}</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                        {activeKey?.walletType}
                      </span>
                    </div>
                    <code className="text-xs font-mono text-amber-400 font-semibold block break-all">
                      {activeKey?.serviceKey}
                    </code>
                  </div>

                  <button
                    onClick={() => copyToClipboard(activeKey?.serviceKey, 'activeKey')}
                    className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-mono text-zinc-200 transition flex items-center gap-1.5 shrink-0"
                  >
                    {copied === 'activeKey' ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-400" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>Copy Key</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Switch between saved agent wallets */}
                {keyList.length > 1 && (
                  <div className="text-xs">
                    <span className="text-[11px] font-mono text-zinc-500 uppercase block mb-1.5">Registered Agent Wallets:</span>
                    <div className="flex flex-wrap gap-2">
                      {keyList.map((k) => (
                        <button
                          key={k.id}
                          onClick={() => setActiveKey(k)}
                          className={`px-2.5 py-1 rounded text-xs font-mono border transition ${
                            activeKey?.id === k.id
                              ? 'border-zinc-500 bg-zinc-800 text-white font-medium'
                              : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          {k.agentName} ({k.walletType})
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Section 2: Agent Configuration Snippets */}
          <section className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-zinc-800/80 gap-3">
              <div>
                <h2 className="text-sm font-semibold text-white">Agent MCP Configuration</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {activeKey 
                    ? `Pre-populated with active key for ${activeKey.agentName}.` 
                    : 'Register an agent wallet above to populate configuration.'}
                </p>
              </div>

              <div className="flex items-center gap-1 bg-zinc-950 p-1 rounded border border-zinc-800 text-xs font-mono">
                {['claude', 'cursor', 'python', 'curl'].map((client) => (
                  <button
                    key={client}
                    onClick={() => setMcpClient(client)}
                    className={`px-2.5 py-1 rounded capitalize transition ${
                      mcpClient === client
                        ? 'bg-zinc-800 text-white font-medium'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {client === 'curl' ? 'cURL' : client}
                  </button>
                ))}
              </div>
            </div>

            <div className="relative">
              <pre className="p-4 rounded bg-zinc-950 border border-zinc-800 text-xs font-mono text-zinc-300 overflow-x-auto leading-relaxed">
                {getSnippet()}
              </pre>

              <button
                onClick={() => copyToClipboard(getSnippet(), 'snippet')}
                disabled={!activeKey}
                className={`absolute top-3 right-3 px-2.5 py-1 rounded text-xs font-mono transition flex items-center gap-1.5 ${
                  activeKey 
                    ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200' 
                    : 'bg-zinc-900 text-zinc-600 cursor-not-allowed'
                }`}
              >
                {copied === 'snippet' ? (
                  <>
                    <Check className="h-3 w-3 text-emerald-400" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    <span>Copy Config</span>
                  </>
                )}
              </button>
            </div>
          </section>

          {/* Section 3: Registered MCP Tools Reference */}
          <section className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-5 space-y-4">
            <div className="pb-3 border-b border-zinc-800/80">
              <h2 className="text-sm font-semibold text-white">Registered MCP Tools</h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Tools automatically exposed to LLMs when AgentPay MCP server runs.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs font-mono">
              <div className="p-3.5 rounded bg-zinc-950 border border-zinc-800 space-y-2">
                <div className="text-amber-400 font-bold font-mono">fetch_with_l402</div>
                <div className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                  Fetches any URL. If the server issues HTTP 402, it routes the payment via AgentPay gateway using your configured wallet, extracts the preimage, and unlocks the data.
                </div>
                <div className="text-[10px] text-zinc-400 bg-zinc-900 p-2 rounded">
                  <code>params: url (string), method? (string), body? (object)</code>
                </div>
              </div>

              <div className="p-3.5 rounded bg-zinc-950 border border-zinc-800 space-y-2">
                <div className="text-amber-400 font-bold font-mono">pay_lightning_invoice</div>
                <div className="text-[11px] text-zinc-400 font-sans leading-relaxed">
                  Direct payment tool. Takes a BOLT11 invoice, executes payment through your registered wallet, and returns the preimage receipt.
                </div>
                <div className="text-[10px] text-zinc-400 bg-zinc-900 p-2 rounded">
                  <code>params: invoice (string)</code>
                </div>
              </div>
            </div>
          </section>

          {/* Section 4: Live Paywall Verification */}
          <section className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-zinc-800/80 gap-3">
              <div>
                <h2 className="text-sm font-semibold text-white">Live Paywall Verification</h2>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Verify that the proxy is actively issuing L402 challenges.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleTestEndpoint}
                  disabled={isTestingEndpoint}
                  className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono transition flex items-center gap-1.5"
                >
                  {isTestingEndpoint ? (
                    <>
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      <span>Testing...</span>
                    </>
                  ) : (
                    <span>Test 402 Paywall</span>
                  )}
                </button>

                <button
                  onClick={() => setCurrentPage('simulation')}
                  className="px-3 py-1.5 rounded bg-white text-black hover:bg-zinc-200 text-xs font-medium transition flex items-center gap-1.5"
                >
                  <span>Go to Simulation</span>
                  <ArrowRight className="h-3 w-3" />
                </button>
              </div>
            </div>

            {quickTestResult && (
              <div
                className={`p-3 rounded border text-xs font-mono ${
                  quickTestResult.status === 402
                    ? 'border-emerald-800 bg-emerald-950/20 text-emerald-300'
                    : 'border-red-800 bg-red-950/20 text-red-300'
                }`}
              >
                <div className="font-semibold">Response: HTTP {quickTestResult.status} (Payment Required)</div>
                <div className="text-[11px] text-zinc-400 mt-1">{quickTestResult.message}</div>
              </div>
            )}
          </section>

        </main>
      )}

      {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          PAGE 2: SIMULATION (DEMO & LIVE SSE STREAM)
         ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {currentPage === 'simulation' && (
        <main className="space-y-6">

          {/* Top Metric Cards */}
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3.5 rounded-lg bg-zinc-900/60 border border-zinc-800">
              <div className="text-[11px] font-mono text-zinc-500 uppercase">Satoshis Settled</div>
              <div className="text-xl font-bold font-mono text-white mt-1">
                {totalSats} <span className="text-xs font-normal text-zinc-500">sats</span>
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-zinc-900/60 border border-zinc-800">
              <div className="text-[11px] font-mono text-zinc-500 uppercase">Invoices Paid</div>
              <div className="text-xl font-bold font-mono text-white mt-1">{settledCount}</div>
            </div>

            <div className="p-3.5 rounded-lg bg-zinc-900/60 border border-zinc-800">
              <div className="text-[11px] font-mono text-zinc-500 uppercase">Active Wallet</div>
              <div className="text-sm font-semibold font-mono text-zinc-200 mt-1.5 truncate">
                {activeKey ? `${activeKey.agentName} (${activeKey.walletType})` : 'None Connected'}
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-zinc-900/60 border border-zinc-800">
              <div className="text-[11px] font-mono text-zinc-500 uppercase">Protocol State</div>
              <div className="mt-1.5 flex items-center gap-1.5 text-xs font-mono font-medium">
                {status === 'pending' ? (
                  <span className="text-amber-400 flex items-center gap-1.5">
                    <Circle className="h-2 w-2 fill-amber-400 text-amber-400 animate-ping" />
                    402 Challenge Issued
                  </span>
                ) : status === 'verified' ? (
                  <span className="text-emerald-400 flex items-center gap-1.5">
                    <Circle className="h-2 w-2 fill-emerald-400 text-emerald-400" />
                    Settled & Unlocked
                  </span>
                ) : (
                  <span className="text-zinc-500 flex items-center gap-1.5">
                    <Circle className="h-2 w-2 fill-zinc-600 text-zinc-600" />
                    Ready
                  </span>
                )}
              </div>
            </div>
          </section>

          {/* Stepper + SSE Feed */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

            {/* Left: Simulation Runner */}
            <section className="lg:col-span-6 bg-zinc-900/60 border border-zinc-800 rounded-lg p-5 space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80">
                <div>
                  <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
                    <Zap className="h-3.5 w-3.5 text-emerald-400 fill-current" />
                    <span>Real Lightning Payment Simulation</span>
                  </h2>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {activeKey ? `Executes live 10-sat Mutinynet payment via ${activeKey.agentName}` : 'Executes live 10-sat Mutinynet payment via connected Voltage node'}
                  </p>
                </div>

                <button
                  onClick={runSimulation}
                  disabled={isSimulating}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition ${
                    isSimulating
                      ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                      : 'bg-emerald-500 text-black hover:bg-emerald-400 font-semibold'
                  }`}
                >
                  {isSimulating ? (
                    <>
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      <span>Executing Real Payment...</span>
                    </>
                  ) : (
                    <>
                      <Zap className="h-3 w-3 fill-current" />
                      <span>Execute Real Payment</span>
                    </>
                  )}
                </button>
              </div>

              {simError && (
                <div className="p-3 rounded bg-red-950/40 border border-red-800/80 text-xs font-mono text-red-300 flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-red-200">Payment Failed on Voltage</div>
                    <div className="text-[11px] text-red-300/80 mt-0.5">{simError}</div>
                  </div>
                </div>
              )}

              {/* Protocol Step Sequence */}
              <div className="space-y-2 text-xs font-mono">
                <div
                  className={`p-3 rounded border transition ${
                    simStep >= 1 ? 'border-zinc-700 bg-zinc-900 text-zinc-100' : 'border-zinc-800/70 bg-zinc-950/40 text-zinc-500'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">1. Agent Request</span>
                    {simStep >= 1 && <Check className="h-3.5 w-3.5 text-zinc-300" />}
                  </div>
                  <div className="text-[11px] text-zinc-400 mt-1">
                    Agent queries restricted resource: <code>GET /api/data</code> (No Auth)
                  </div>
                </div>

                <div
                  className={`p-3 rounded border transition ${
                    simStep >= 2 ? 'border-amber-900/80 bg-amber-950/20 text-amber-200' : 'border-zinc-800/70 bg-zinc-950/40 text-zinc-500'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">2. Server 402 Challenge</span>
                    {simStep >= 2 && <Check className="h-3.5 w-3.5 text-amber-400" />}
                  </div>
                  <div className="text-[11px] text-zinc-400 mt-1">
                    Proxy creates real 10 sat Mutinynet invoice on Voltage node & returns 402
                  </div>
                </div>

                <div
                  className={`p-3 rounded border transition ${
                    simStep >= 3 ? 'border-amber-800 bg-amber-950/30 text-amber-200' : 'border-zinc-800/70 bg-zinc-950/40 text-zinc-500'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">3. Voltage Wallet Settlement</span>
                    {simStep >= 3 && <Check className="h-3.5 w-3.5 text-amber-400" />}
                  </div>
                  <div className="text-[11px] text-zinc-400 mt-1">
                    Voltage API posts payment & debits wallet ledger (-10 sats)
                  </div>
                </div>

                <div
                  className={`p-3 rounded border transition ${
                    simStep >= 4 ? 'border-emerald-800 bg-emerald-950/20 text-emerald-200' : 'border-zinc-800/70 bg-zinc-950/40 text-zinc-500'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">4. Unlocked 200 OK</span>
                    {simStep >= 4 && <Check className="h-3.5 w-3.5 text-emerald-400" />}
                  </div>
                  <div className="text-[11px] text-zinc-400 mt-1">
                    Authorization: L402 token:preimage verified. Premium payload unlocked!
                  </div>
                </div>
              </div>

              {/* Real Lightning Settlement Receipt */}
              {simDetails && (
                <div className="p-4 rounded-lg bg-zinc-950 border border-emerald-800/70 text-xs font-mono space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-zinc-800/80">
                    <div className="flex items-center gap-2">
                      <span className="flex h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                      <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wide">
                        Real Lightning Settlement Verified
                      </span>
                    </div>
                    <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-800/80 font-bold">
                      -10 SATS OUTFLOW
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-[11px]">
                    <div className="p-2 rounded bg-zinc-900/60 border border-zinc-800">
                      <span className="text-zinc-500 block text-[10px] uppercase">Network & Node</span>
                      <span className="text-zinc-200 font-medium">Mutinynet Signet (Voltage Cloud)</span>
                    </div>
                    <div className="p-2 rounded bg-zinc-900/60 border border-zinc-800">
                      <span className="text-zinc-500 block text-[10px] uppercase">Paying Agent</span>
                      <span className="text-zinc-200 font-medium">{simDetails.agent || 'Connected Wallet'}</span>
                    </div>
                  </div>

                  {simDetails.voltageDetails && (
                    <div className="p-2.5 rounded bg-zinc-900/40 border border-zinc-800/70 text-[11px] space-y-1">
                      <div className="flex items-center justify-between text-zinc-400">
                        <span>Voltage Payment ID:</span>
                        <span className="text-zinc-300 font-mono text-[10px] select-all">
                          {simDetails.voltageDetails.paymentId}
                        </span>
                      </div>
                      {simDetails.voltageDetails.ledgerId && (
                        <div className="flex items-center justify-between text-zinc-400">
                          <span>Ledger Debit ID:</span>
                          <span className="text-zinc-300 font-mono text-[10px] select-all">
                            {simDetails.voltageDetails.ledgerId}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Cryptographic Preimage Proof */}
                  <div className="p-2.5 rounded bg-zinc-900/80 border border-zinc-800 space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-zinc-400 uppercase tracking-wider">
                      <span>Settlement Preimage (Cryptographic Proof)</span>
                      <button
                        onClick={() => copyToClipboard(simDetails.preimage, 'preimage')}
                        className="text-zinc-400 hover:text-white"
                      >
                        {copied === 'preimage' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <div className="text-[11px] text-emerald-300 break-all select-all font-mono">
                      {simDetails.preimage}
                    </div>
                  </div>

                  {/* Payment Hash */}
                  <div className="p-2.5 rounded bg-zinc-900/80 border border-zinc-800 space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-zinc-400 uppercase tracking-wider">
                      <span>Payment Hash (R-Hash)</span>
                      <button
                        onClick={() => copyToClipboard(simDetails.paymentHash, 'simHash')}
                        className="text-zinc-400 hover:text-white"
                      >
                        {copied === 'simHash' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <div className="text-[11px] text-zinc-300 break-all select-all font-mono">
                      {simDetails.paymentHash}
                    </div>
                  </div>

                  {/* BOLT11 Invoice */}
                  <div className="p-2.5 rounded bg-zinc-900/80 border border-zinc-800 space-y-1">
                    <div className="flex items-center justify-between text-[10px] text-zinc-400 uppercase tracking-wider">
                      <span>BOLT11 Invoice</span>
                      <button
                        onClick={() => copyToClipboard(simDetails.invoice, 'simInv')}
                        className="text-zinc-400 hover:text-white"
                      >
                        {copied === 'simInv' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <div className="text-[11px] text-zinc-400 break-all font-mono line-clamp-2 hover:line-clamp-none transition">
                      {simDetails.invoice}
                    </div>
                  </div>

                  <div className="pt-2 border-t border-zinc-800/80 text-[11px] text-zinc-400 flex items-center justify-between">
                    <span>Actual balance outflow confirmed on Voltage.</span>
                    <span className="text-emerald-400 font-semibold">Wallet Ledger Updated</span>
                  </div>
                </div>
              )}

              {simData && (
                <div className="p-3 rounded bg-zinc-950 border border-zinc-800 text-xs font-mono space-y-1.5">
                  <div className="text-[11px] text-emerald-400 font-semibold flex items-center justify-between">
                    <span>Unlocked Payload:</span>
                    <span className="text-zinc-500 font-normal">HTTP 200 OK</span>
                  </div>
                  <pre className="text-[11px] text-zinc-300 leading-relaxed overflow-x-auto">
                    {JSON.stringify(simData, null, 2)}
                  </pre>
                </div>
              )}
            </section>

            {/* Right: Live SSE Stream */}
            <section className="lg:col-span-6 bg-zinc-900/60 border border-zinc-800 rounded-lg p-5 flex flex-col min-h-[460px]">
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80">
                <div>
                  <h2 className="text-sm font-semibold text-white">Live Event Stream</h2>
                  <p className="text-xs text-zinc-400 mt-0.5">Real-time SSE events broadcast by AgentPay</p>
                </div>

                <button
                  onClick={() => setEvents([])}
                  className="text-[11px] font-mono text-zinc-400 hover:text-zinc-200"
                >
                  Clear Feed
                </button>
              </div>

              <div ref={feedRef} className="mt-3 flex-1 overflow-y-auto space-y-2 max-h-[440px] pr-1">
                {events.length === 0 ? (
                  <div className="text-center py-24 text-xs font-mono text-zinc-500">
                    No stream events yet. Click "Execute Real Payment" or query /api/data.
                  </div>
                ) : (
                  events.map((e) => (
                    <div
                      key={e.id}
                      className={`p-3 rounded border text-xs font-mono ${
                        e.type === 'payment_verified'
                          ? 'border-emerald-900/80 bg-emerald-950/20 text-emerald-300'
                          : 'border-zinc-800 bg-zinc-950 text-zinc-300'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-white">{e.title}</span>
                        <span className="text-[10px] text-zinc-500">{e.time}</span>
                      </div>
                      <div className="text-[11px] text-zinc-400 mt-0.5">{e.detail}</div>
                      {e.hash && (
                        <div className="mt-1.5 pt-1.5 border-t border-zinc-800/60 flex items-center justify-between text-[10px] text-zinc-500">
                          <span>hash: {e.hash.slice(0, 22)}...</span>
                          <button
                            onClick={() => copyToClipboard(e.hash, e.id)}
                            className="text-zinc-400 hover:text-zinc-200"
                          >
                            {copied === e.id ? 'Copied' : 'Copy Hash'}
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>

          </div>

          {/* Voltage Node Wallet Activity & Live Ledger Outflows */}
          <section className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800/80">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-white">Voltage Node Wallet Activity (Live Ledger)</h2>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                    Mutinynet Signet
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Live payments recorded by Voltage API for wallet <span className="font-mono text-zinc-300">{walletId ? `${walletId.slice(0, 20)}...` : 'Connected Wallet'}</span>
                </p>
              </div>

              <button
                onClick={fetchWalletHistory}
                disabled={isLoadingHistory}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition"
              >
                <RefreshCw className={`h-3 w-3 ${isLoadingHistory ? 'animate-spin' : ''}`} />
                <span>{isLoadingHistory ? 'Refreshing...' : 'Refresh Ledger'}</span>
              </button>
            </div>

            {walletHistory.length === 0 ? (
              <div className="text-center py-8 text-xs font-mono text-zinc-500">
                Loading wallet activity from Voltage...
              </div>
            ) : (
              <div className="space-y-2">
                {walletHistory.map((item) => (
                  <div
                    key={item.id}
                    className="p-3 rounded bg-zinc-950 border border-zinc-800 flex flex-col md:flex-row md:items-center justify-between gap-2 text-xs font-mono"
                  >
                    <div className="flex items-center gap-2.5">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                          item.direction === 'send'
                            ? 'bg-amber-950/60 text-amber-300 border border-amber-800/60'
                            : 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/60'
                        }`}
                      >
                        {item.direction === 'send' ? '- OUTFLOW' : '+ INFLOW'}
                      </span>
                      <div>
                        <div className="font-medium text-zinc-200 flex items-center gap-2">
                          <span>{item.amountSats} SATS</span>
                          <span className="text-zinc-500 text-[11px] font-normal">({item.memo})</span>
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-0.5">
                          ID: {item.id.slice(0, 24)}...
                          {item.ledgerId && ` • Ledger: ${item.ledgerId.slice(0, 16)}...`}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 text-[11px] text-zinc-400 justify-between md:justify-end">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] capitalize ${
                          item.status === 'completed'
                            ? 'text-emerald-400 bg-emerald-950/40'
                            : item.status === 'failed'
                            ? 'text-red-400 bg-red-950/40'
                            : 'text-zinc-400 bg-zinc-800/60'
                        }`}
                      >
                        {item.status}
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

        </main>
      )}

    </div>
  );
}
