const BASE   = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
const WS_URL = import.meta.env.VITE_WS_URL  || 'ws://localhost:4000';

// ── TOKEN STORAGE
export const getToken  = ()      => localStorage.getItem('fanbassy_token');
export const setToken  = (t)     => localStorage.setItem('fanbassy_token', t);
export const clearToken = ()     => localStorage.removeItem('fanbassy_token');

// ── HTTP CLIENT
const req = async (method, path, body) => {
  const token = getToken();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

// ── API METHODS
export const api = {
  // Auth
  register:     (email, username, password, refCode) =>
    req('POST', '/auth/register', { email, username, password, refCode }),
  login:        (email, password) =>
    req('POST', '/auth/login', { email, password }),
  me:           () => req('GET', '/auth/me'),

  // Wallet
  getBalance:      ()             => req('GET',  '/wallet/balance'),
  getTransactions: ()             => req('GET',  '/wallet/transactions'),
  deposit:         (amount)       => req('POST', '/wallet/deposit',  { amount }),
  withdraw:        (amount, clabe)=> req('POST', '/wallet/withdraw', { amount, clabe }),

  // Predictions
  getOpen:      (matchId) => req('GET', `/predictions/open${matchId ? `?matchId=${matchId}` : ''}`),
  getResolved:  (matchId) => req('GET', `/predictions/resolved${matchId ? `?matchId=${matchId}` : ''}`),
  placeBet:     (predId, optIdx, amount) =>
    req('POST', '/predictions/bet', { predId, optIdx, amount }),
  getHistory:   () => req('GET', '/predictions/history'),

  // Admin
  getStats:            ()  => req('GET',  '/admin/stats'),
  getAdminUsers:       ()  => req('GET',  '/admin/users'),
  getWithdrawals:      ()  => req('GET',  '/admin/withdrawals'),
  approveWithdrawal:   (id)=> req('POST', `/admin/withdrawals/${id}/approve`),
  rejectWithdrawal:    (id)=> req('POST', `/admin/withdrawals/${id}/reject`),
  toggleUser:          (id)=> req('POST', `/admin/users/${id}/toggle`),
};

// ── WEBSOCKET
let ws = null;
let wsListeners = {};
let reconnectTimer = null;

export const wsConnect = (handlers) => {
  wsListeners = handlers || {};
  connect();
};

const connect = () => {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[WS] Connected');
    clearTimeout(reconnectTimer);
    wsListeners.onConnect?.();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      wsListeners.onMessage?.(msg);
    } catch {}
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected — reconnecting in 3s');
    wsListeners.onDisconnect?.();
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = (err) => {
    console.warn('[WS] Error:', err.message);
  };
};

export const wsDisconnect = () => {
  clearTimeout(reconnectTimer);
  if (ws) { ws.close(); ws = null; }
};
