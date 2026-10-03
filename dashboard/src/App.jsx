import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Check, Copy, RefreshCw, Circle, ArrowRight, 
  User, LogOut, Lock, Key, AlertCircle, Shield, Zap, Trash2,
  Sliders, RotateCcw
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
  getDocs,
  deleteDoc
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
  const [currentPage, setCurrentPage] = useState('integration'); // 'integration' | 'activity'

  // ── Shared SSE & UI State ──
  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [copied, setCopied] = useState(null);

  // ── Integration Page State ──
  const [mcpClient, setMcpClient] = useState('antigravity'); // 'antigravity' | 'claude' | 'python' | 'curl'
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
  const [spendLimit, setSpendLimit] = useState(500); // Default spend limit 500 sats (0 = unlimited)
  const [isEditingLimit, setIsEditingLimit] = useState(false);
  const [editLimitInput, setEditLimitInput] = useState(500);
  const [isSavingLimit, setIsSavingLimit] = useState(false);
  const [isRefreshingSpend, setIsRefreshingSpend] = useState(false);

  const [keyList, setKeyList] = useState([]);
  const [activeKey, setActiveKey] = useState(null);
  const [isCreatingKey, setIsCreatingKey] = useState(false);
  const [isSavingKey, setIsSavingKey] = useState(false);

  // ── Live Activity Page State ──
  const [totalSats, setTotalSats] = useState(0);
  const [settledCount, setSettledCount] = useState(0);
  const [activeSessions, setActiveSessions] = useState(0);
  const [status, setStatus] = useState('idle'); // 'idle' | 'pending' | 'verified'
  const [events, setEvents] = useState([]);
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
          setActiveKey((prev) => {
            if (prev) {
              const matched = d.keys.find((k) => k.id === prev.id || k.serviceKey === prev.serviceKey);
              if (matched) return matched;
            }
            return d.keys[0];
          });
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
          setKeyList(fsAgents);
          setActiveKey((prev) => {
            if (prev) {
              const matched = fsAgents.find((k) => k.id === prev.id || k.serviceKey === prev.serviceKey);
              if (matched) return matched;
            }
            return fsAgents[0];
          });
        }
      } catch (fsErr) {
        console.warn("[AgentPay] Firestore read note:", fsErr.message);
      }
    }
  };

  // ── One-Click Quick Refresh Spend Counter & Agent Limits ──
  const handleRefreshSpend = async () => {
    if (!user) return;
    setIsRefreshingSpend(true);
    try {
      await loadUserAgents(user);
    } catch (err) {
      console.error("[AgentPay] Failed to refresh spend:", err);
    } finally {
      setTimeout(() => setIsRefreshingSpend(false), 450);
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

    es.addEventListener('spend_updated', (e) => {
      try {
        const data = JSON.parse(e.data);
        setKeyList((prev) => prev.map((k) => {
          if (k.id === data.agentId || k.serviceKey === data.serviceKey) {
            return { ...k, totalSpentSats: data.totalSpentSats, spendLimit: data.spendLimit };
          }
          return k;
        }));
        setActiveKey((prev) => {
          if (prev && (prev.id === data.agentId || prev.serviceKey === data.serviceKey)) {
            return { ...prev, totalSpentSats: data.totalSpentSats, spendLimit: data.spendLimit };
          }
          return prev;
        });
      } catch (err) {
        console.error('[SSE] Error handling spend_updated:', err);
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

  // ── Fetch Live Wallet Ledger & Transactions from Node / NWC ──
  const fetchWalletHistory = async (targetKey = activeKey) => {
    setIsLoadingHistory(true);
    try {
      const keyParam = targetKey?.serviceKey ? `?key=${encodeURIComponent(targetKey.serviceKey)}` : '';
      const res = await fetch(`${API_BASE}/api/wallet/recent-payments${keyParam}`);
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

  // Load wallet history on auth, tab switch, or when active agent changes
  useEffect(() => {
    if (user && currentPage === 'activity') {
      fetchWalletHistory(activeKey);
    }
  }, [user, currentPage, activeKey?.id]);

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
      const parsedLimit = Number(spendLimit) >= 0 ? Number(spendLimit) : 500;
      const res = await fetch(`${API_BASE}/api/keys`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({ 
          agentName: newKeyName, 
          walletType, 
          walletConfig,
          spendLimit: parsedLimit
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
              spendLimit: parsedLimit,
              totalSpentSats: 0,
              walletConfig: walletConfig, // All Voltage orgId, envId, walletId, apiKey / NWC / LND config
              network: walletType === 'nwc' ? 'NWC (Alby/Primal/Mutiny)' : walletType === 'lnd' ? 'LND Custom Node' : 'Voltage Cloud (Mutinynet)',
              createdAt: new Date().toISOString(),
              active: true
            });
          } catch (fsErr) {
            console.warn("[AgentPay] Firestore write note:", fsErr.message);
            if (fsErr.message?.includes('permission') || fsErr.code === 'permission-denied') {
              alert("Notice: Agent saved on Gateway, but your Firestore Rules blocked the write. Please add a rule for /users/{userId} in Firebase Console.");
            }
          }
        }

        setKeyList((prev) => [d.key, ...prev]);
        setActiveKey(d.key);
        setNewKeyName('');
        setSpendLimit(500);
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

  // ── Update Agent Spend Limit / Reset Spent Counter ──
  const handleUpdateSpendLimit = async (agentId, newLimit, resetSpent = false) => {
    if (!agentId || !user) return;
    setIsSavingLimit(true);

    const numericLimit = Number(newLimit);
    const validLimit = !isNaN(numericLimit) && numericLimit >= 0 ? numericLimit : 0;

    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${API_BASE}/api/keys/${agentId}`, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({ 
          spendLimit: validLimit, 
          resetSpent 
        })
      });

      const d = await res.json();
      if (d.success && d.key) {
        // Sync to Firestore
        if (db) {
          try {
            const updates = { 
              spendLimit: validLimit,
              ...(resetSpent ? { totalSpentSats: 0 } : {})
            };
            await setDoc(doc(db, "users", user.uid, "agents", agentId), updates, { merge: true });
          } catch (fsErr) {
            console.warn("[AgentPay] Firestore spend update note:", fsErr.message);
          }
        }

        setKeyList((prev) => prev.map((k) => (k.id === agentId ? { ...k, ...d.key } : k)));
        if (activeKey?.id === agentId) {
          setActiveKey((prev) => ({ ...prev, ...d.key }));
        }
        setIsEditingLimit(false);
      } else {
        alert(d.error || 'Failed to update spend limit.');
      }
    } catch (err) {
      console.error('Failed to update spend limit:', err);
      alert('Error updating spend limit: ' + err.message);
    } finally {
      setIsSavingLimit(false);
    }
  };

  // ── Delete Agent Credentials from Firestore & Gateway ──
  const handleDeleteAgent = async (agentToDelete) => {
    if (!agentToDelete || !user) return;
    const confirmDelete = window.confirm(`Are you sure you want to delete '${agentToDelete.agentName}'? This will revoke the service key immediately.`);
    if (!confirmDelete) return;

    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`${API_BASE}/api/keys/${agentToDelete.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${idToken}`
        }
      });
      const d = await res.json();
      if (d.success) {
        if (db) {
          try {
            await deleteDoc(doc(db, "users", user.uid, "agents", agentToDelete.id));
          } catch (e) {}
        }
        const updatedList = keyList.filter((k) => k.id !== agentToDelete.id);
        setKeyList(updatedList);
        if (activeKey?.id === agentToDelete.id) {
          setActiveKey(updatedList.length > 0 ? updatedList[0] : null);
        }
      } else {
        alert(d.error || 'Failed to delete agent.');
      }
    } catch (err) {
      console.error('Error deleting agent:', err);
      alert('Failed to delete agent: ' + err.message);
    }
  };


  const currentKeyString = activeKey?.serviceKey || '<register-an-agent-to-generate-key>';

  const getSnippet = () => {
    switch (mcpClient) {
      case 'claude':
        return JSON.stringify(
          {
            mcpServers: {
              "agentpay": {
                url: `${API_BASE}/sse`,
                headers: {
                  Authorization: `Bearer ${currentKeyString}`
                }
              }
            }
          },
          null,
          2
        );
      case 'python':
        return `# Python (LangChain / CrewAI / Smolagents / AutoGen)
import requests

# 1. Query paywalled resource
response = requests.get("${API_BASE}/api/data")

# 2. When HTTP 402 is returned, route payment through AgentPay Gateway:
# POST ${API_BASE}/api/gateway/pay
# Headers: {'Authorization': 'Bearer ${currentKeyString}'}
# Body: {'invoice': invoice}
print("Authenticated and unlocked via AgentPay Gateway")`;
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
      case 'antigravity':
      default:
        return JSON.stringify(
          {
            mcpServers: {
              "agentpay": {
                serverUrl: `${API_BASE}/sse?key=${currentKeyString}`
              }
            }
          },
          null,
          2
        );
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
              onClick={() => setCurrentPage('activity')}
              className={`px-3 py-1.5 rounded transition ${
                currentPage === 'activity'
                  ? 'bg-zinc-700 text-white font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Live Activity
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

                {/* Autonomous Spend Limit Configuration */}
                <div className="p-3 rounded bg-zinc-900/80 border border-zinc-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] font-mono text-zinc-300 font-semibold block">
                      Autonomous Spend Limit (Satoshis)
                    </label>
                    <span className="text-[10px] font-mono text-zinc-400">
                      Gateway blocks payments (HTTP 403) when budget is exceeded
                    </span>
                  </div>
                  
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      step="10"
                      value={spendLimit}
                      onChange={(e) => setSpendLimit(e.target.value)}
                      placeholder="e.g. 500"
                      className="w-36 bg-zinc-950 border border-zinc-700 rounded px-2.5 py-1.5 font-mono text-xs text-zinc-200 focus:outline-none focus:border-amber-400"
                      required
                    />
                    <span className="text-xs font-mono text-zinc-400">sats</span>

                    {/* Presets */}
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono ml-auto">
                      {[
                        { label: '100 sats', val: 100 },
                        { label: '500 sats', val: 500 },
                        { label: '1,000 sats', val: 1000 },
                        { label: '5,000 sats', val: 5000 },
                        { label: 'Unlimited (0)', val: 0 }
                      ].map((preset) => (
                        <button
                          key={preset.val}
                          type="button"
                          onClick={() => setSpendLimit(preset.val)}
                          className={`px-2 py-1 rounded border transition ${
                            Number(spendLimit) === preset.val
                              ? 'bg-amber-400 text-black border-amber-300 font-semibold'
                              : 'bg-zinc-950 border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

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

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => copyToClipboard(activeKey?.serviceKey, 'activeKey')}
                      className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-xs font-mono text-zinc-200 transition flex items-center gap-1.5"
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

                    <button
                      onClick={() => handleDeleteAgent(activeKey)}
                      title="Delete Agent"
                      className="px-2.5 py-1.5 rounded bg-red-950/40 hover:bg-red-900/60 border border-red-800/50 text-red-300 text-xs transition flex items-center gap-1.5"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Delete</span>
                    </button>
                  </div>
                </div>

                {/* ── Autonomous Spend Limit & Budget Meter ── */}
                <div className="p-3.5 rounded bg-zinc-950 border border-zinc-800 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Sliders className="h-3.5 w-3.5 text-amber-400" />
                      <span className="text-xs font-semibold text-white">Autonomous Spend Limit</span>
                      <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-medium border ${
                        activeKey?.spendLimit > 0 && (activeKey?.totalSpentSats || 0) >= activeKey?.spendLimit
                          ? 'bg-red-950/80 text-red-400 border-red-800/60'
                          : activeKey?.spendLimit > 0
                          ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/60'
                          : 'bg-zinc-900 text-zinc-400 border-zinc-700'
                      }`}>
                        {activeKey?.spendLimit > 0 && (activeKey?.totalSpentSats || 0) >= activeKey?.spendLimit
                          ? 'LIMIT REACHED (PAYMENTS BLOCKED)'
                          : activeKey?.spendLimit > 0
                          ? 'BUDGET ACTIVE'
                          : 'UNLIMITED SPEND'}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={handleRefreshSpend}
                        disabled={isRefreshingSpend}
                        title="Refresh latest spend from wallet & database"
                        className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-[11px] font-mono transition flex items-center gap-1"
                      >
                        <RefreshCw className={`h-3 w-3 ${isRefreshingSpend ? 'animate-spin text-amber-400' : 'text-zinc-400'}`} />
                        <span>{isRefreshingSpend ? 'Syncing...' : 'Refresh'}</span>
                      </button>

                      <button
                        onClick={() => {
                          setEditLimitInput(activeKey?.spendLimit ?? 500);
                          setIsEditingLimit(!isEditingLimit);
                        }}
                        className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] font-mono transition flex items-center gap-1"
                      >
                        <Sliders className="h-3 w-3" />
                        <span>{isEditingLimit ? 'Close' : 'Adjust Limit'}</span>
                      </button>

                      {(activeKey?.totalSpentSats || 0) > 0 && (
                        <button
                          onClick={() => {
                            if (window.confirm(`Reset spend counter for ${activeKey?.agentName} back to 0 sats?`)) {
                              handleUpdateSpendLimit(activeKey.id, activeKey.spendLimit ?? 500, true);
                            }
                          }}
                          disabled={isSavingLimit}
                          title="Reset spent sats counter back to 0"
                          className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-[11px] font-mono transition flex items-center gap-1"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>Reset Spent</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Inline Limit Editor */}
                  {isEditingLimit && (
                    <div className="p-3 rounded bg-zinc-900 border border-zinc-700 space-y-2.5">
                      <div className="text-[11px] font-mono text-zinc-300">
                        Set Max Budget in Satoshis (Enter 0 for Unlimited):
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          step="10"
                          value={editLimitInput}
                          onChange={(e) => setEditLimitInput(e.target.value)}
                          className="w-32 bg-zinc-950 border border-zinc-700 rounded px-2.5 py-1 font-mono text-xs text-white focus:outline-none focus:border-amber-400"
                        />
                        <span className="text-xs font-mono text-zinc-400">sats</span>

                        {/* Quick Presets */}
                        <div className="flex flex-wrap items-center gap-1 text-[10px] font-mono">
                          {[100, 500, 1000, 5000, 0].map((preset) => (
                            <button
                              key={preset}
                              type="button"
                              onClick={() => setEditLimitInput(preset)}
                              className={`px-2 py-0.5 rounded border transition ${
                                Number(editLimitInput) === preset
                                  ? 'bg-amber-400 text-black border-amber-300 font-semibold'
                                  : 'bg-zinc-950 hover:bg-zinc-800 border-zinc-700 text-zinc-300'
                              }`}
                            >
                              {preset === 0 ? 'Unlimited' : `${preset.toLocaleString()} sats`}
                            </button>
                          ))}
                        </div>

                        <button
                          type="button"
                          disabled={isSavingLimit}
                          onClick={() => handleUpdateSpendLimit(activeKey.id, editLimitInput, false)}
                          className="ml-auto px-3 py-1 rounded bg-amber-400 hover:bg-amber-300 text-black font-semibold text-xs font-mono transition flex items-center gap-1.5"
                        >
                          {isSavingLimit ? (
                            <>
                              <RefreshCw className="h-3 w-3 animate-spin" />
                              <span>Saving...</span>
                            </>
                          ) : (
                            <span>Save Limit</span>
                          )}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Budget Metrics & Progress Bar */}
                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <div>
                        <span className="text-zinc-400">Spent: </span>
                        <span className="text-white font-semibold">{(activeKey?.totalSpentSats || 0).toLocaleString()} sats</span>
                        <span className="text-zinc-500"> / </span>
                        <span className="text-zinc-300 font-semibold">
                          {activeKey?.spendLimit > 0 ? `${activeKey.spendLimit.toLocaleString()} sats` : 'Unlimited'}
                        </span>
                      </div>
                      <div className="text-zinc-400 text-[11px]">
                        {activeKey?.spendLimit > 0 ? (
                          <span>
                            Remaining: <span className="text-white font-semibold">{Math.max(0, activeKey.spendLimit - (activeKey.totalSpentSats || 0)).toLocaleString()} sats</span>
                          </span>
                        ) : (
                          <span className="text-zinc-500">No cap enforced</span>
                        )}
                      </div>
                    </div>

                    {/* Progress Bar (Only when spendLimit > 0) */}
                    {activeKey?.spendLimit > 0 && (
                      <div className="w-full h-2 rounded-full bg-zinc-900 border border-zinc-800 overflow-hidden">
                        <div
                          className={`h-full transition-all duration-500 ${
                            (activeKey?.totalSpentSats || 0) >= activeKey?.spendLimit
                              ? 'bg-red-500'
                              : ((activeKey?.totalSpentSats || 0) / activeKey?.spendLimit) >= 0.75
                              ? 'bg-amber-400'
                              : 'bg-emerald-500'
                          }`}
                          style={{
                            width: `${Math.min(100, Math.round(((activeKey?.totalSpentSats || 0) / activeKey?.spendLimit) * 100))}%`
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* Switch between saved agent wallets */}
                {keyList.length > 1 && (
                  <div className="text-xs">
                    <span className="text-[11px] font-mono text-zinc-500 uppercase block mb-1.5">Registered Agent Wallets:</span>
                    <div className="flex flex-wrap gap-2">
                      {keyList.map((k) => (
                        <div
                          key={k.id}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono border transition ${
                            activeKey?.id === k.id
                              ? 'border-zinc-500 bg-zinc-800 text-white font-medium'
                              : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          <button
                            onClick={() => {
                              setActiveKey(k);
                              setEditLimitInput(k.spendLimit ?? 500);
                            }}
                            className="hover:underline flex items-center gap-1.5"
                          >
                            <span>{k.agentName}</span>
                            <span className="text-[10px] text-zinc-500">({k.walletType})</span>
                            <span className={`text-[10px] px-1 py-0.2 rounded font-mono ${
                              k.spendLimit > 0 && (k.totalSpentSats || 0) >= k.spendLimit
                                ? 'bg-red-950 text-red-400'
                                : 'bg-zinc-900 text-zinc-400'
                            }`}>
                              {(k.totalSpentSats || 0)}/{k.spendLimit > 0 ? k.spendLimit : '∞'}
                            </span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteAgent(k);
                            }}
                            title={`Delete ${k.agentName}`}
                            className="text-zinc-500 hover:text-red-400 transition ml-1"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
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

              <div className="flex flex-wrap items-center gap-1 bg-zinc-950 p-1 rounded border border-zinc-800 text-xs font-mono">
                {[
                  { id: 'antigravity', label: 'Antigravity / Gemini IDE' },
                  { id: 'claude', label: 'Claude Desktop / Cursor' },
                  { id: 'python', label: 'Python SDK' },
                  { id: 'curl', label: 'cURL / REST' }
                ].map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setMcpClient(item.id)}
                    className={`px-3 py-1.5 rounded transition ${
                      mcpClient === item.id
                        ? 'bg-zinc-800 text-white font-medium'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {item.label}
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


        </main>
      )}

      {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          PAGE 2: LIVE ACTIVITY (CLEAN WALLET LEDGER)
         ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {currentPage === 'activity' && (
        <main className="space-y-6">

          {/* Top Metric Cards */}
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3.5 rounded-lg bg-zinc-900/60 border border-zinc-800">
              <div className="text-[11px] font-mono text-zinc-500 uppercase">Satoshis Settled</div>
              <div className="text-xl font-bold font-mono text-white mt-1">
                {totalSats.toLocaleString()} <span className="text-xs font-normal text-zinc-500">sats</span>
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-zinc-900/60 border border-zinc-800">
              <div className="text-[11px] font-mono text-zinc-500 uppercase">Invoices Paid</div>
              <div className="text-xl font-bold font-mono text-white mt-1">{settledCount}</div>
            </div>

            <div className="p-3.5 rounded-lg bg-zinc-900/60 border border-zinc-800">
              <div className="text-[11px] font-mono text-zinc-500 uppercase">Active Agent</div>
              <div className="text-sm font-semibold font-mono text-zinc-200 mt-1.5 truncate">
                {activeKey ? activeKey.agentName : 'None Selected'}
              </div>
              <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
                {activeKey?.walletType === 'nwc' ? 'NWC (Nostr)' : activeKey?.walletType === 'lnd' ? 'Custom LND' : 'Voltage Cloud'}
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-zinc-900/60 border border-zinc-800">
              <div className="text-[11px] font-mono text-zinc-500 uppercase">Spend vs Budget</div>
              <div className="text-sm font-bold font-mono text-white mt-1.5 truncate">
                {(activeKey?.totalSpentSats || 0).toLocaleString()} <span className="text-zinc-500 font-normal">/ {activeKey?.spendLimit > 0 ? `${activeKey.spendLimit.toLocaleString()} sats` : 'Unlimited'}</span>
              </div>
              <div className="text-[10px] font-mono text-emerald-400 mt-0.5">
                {activeKey?.spendLimit > 0 && (activeKey?.totalSpentSats || 0) >= activeKey?.spendLimit ? (
                  <span className="text-red-400">Limit Exhausted</span>
                ) : (
                  <span>Budget Active</span>
                )}
              </div>
            </div>
          </section>

          {/* Connected Autonomous Wallet Activity & Live Ledger */}
          <section className="bg-zinc-900/60 border border-zinc-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-zinc-800/80 gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-white">Connected Wallet Activity (Live Ledger)</h2>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 font-semibold">
                    {activeKey?.walletType === 'nwc'
                      ? 'Nostr Wallet Connect (NWC)'
                      : activeKey?.walletType === 'lnd'
                      ? 'Custom LND Node'
                      : 'Voltage Cloud (Mutinynet)'}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Live on-chain and Lightning transactions recorded for <span className="font-mono text-zinc-200">{activeKey?.agentName || 'Active Agent'}</span>
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    await fetchWalletHistory();
                    if (user) await loadUserAgents(user);
                  }}
                  disabled={isLoadingHistory}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition"
                >
                  <RefreshCw className={`h-3 w-3 ${isLoadingHistory ? 'animate-spin text-amber-400' : ''}`} />
                  <span>{isLoadingHistory ? 'Refreshing...' : 'Refresh Ledger'}</span>
                </button>
              </div>
            </div>

            {/* If user has multiple registered agents, allow switching right here on the ledger */}
            {keyList.length > 1 && (
              <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs font-mono">
                <span className="text-[11px] text-zinc-500 uppercase shrink-0">Filter Agent:</span>
                {keyList.map((k) => (
                  <button
                    key={k.id}
                    onClick={() => setActiveKey(k)}
                    className={`px-2.5 py-1 rounded text-xs transition shrink-0 ${
                      activeKey?.id === k.id
                        ? 'bg-zinc-800 text-white font-medium border border-zinc-600'
                        : 'bg-zinc-950 text-zinc-400 hover:text-zinc-200 border border-zinc-850'
                    }`}
                  >
                    {k.agentName} ({k.walletType})
                  </button>
                ))}
              </div>
            )}

            {/* Ledger Transactions */}
            {walletHistory.length === 0 ? (
              <div className="py-12 text-center space-y-3 bg-zinc-950/60 rounded border border-zinc-800/80 p-6">
                <div className="h-10 w-10 rounded-full bg-zinc-900 border border-zinc-800 mx-auto flex items-center justify-center text-zinc-400">
                  <Zap className="h-5 w-5 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">No Ledger Transactions Yet</h3>
                  <p className="text-xs text-zinc-400 mt-1 max-w-md mx-auto">
                    Transactions executed autonomously by your AI agent using <code className="text-zinc-300">pay_lightning_invoice</code> or <code className="text-zinc-300">fetch_with_l402</code> will appear here automatically.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {walletHistory.map((item) => (
                  <div
                    key={item.id}
                    className="p-3.5 rounded bg-zinc-950 border border-zinc-800 flex flex-col md:flex-row md:items-center justify-between gap-2.5 text-xs font-mono hover:border-zinc-700 transition"
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
                          <span className="font-semibold text-white">{item.amountSats} SATS</span>
                          <span className="text-zinc-400 text-[11px] font-normal">({item.memo})</span>
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-0.5 flex flex-wrap items-center gap-2">
                          <span>ID: {item.id.slice(0, 24)}...</span>
                          {item.ledgerId && <span>• Ledger: {item.ledgerId.slice(0, 16)}...</span>}
                          {item.preimage && <span>• Preimage: {item.preimage.slice(0, 16)}...</span>}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 text-[11px] text-zinc-400 justify-between md:justify-end shrink-0">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] capitalize font-medium ${
                          item.status === 'completed'
                            ? 'text-emerald-400 bg-emerald-950/60 border border-emerald-800/50'
                            : item.status === 'failed'
                            ? 'text-red-400 bg-red-950/60 border border-red-800/50'
                            : 'text-zinc-400 bg-zinc-800/60 border border-zinc-700'
                        }`}
                      >
                        {item.status}
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        {item.createdAt ? new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'Just now'}
                      </span>
                      {item.preimage && (
                        <button
                          onClick={() => copyToClipboard(item.preimage, item.id)}
                          className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 transition"
                        >
                          {copied === item.id ? 'Copied' : 'Copy Receipt'}
                        </button>
                      )}
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
