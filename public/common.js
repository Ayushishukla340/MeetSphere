const $ = (id) => document.getElementById(id);
async function api(path, opt = {}) {
  let r, d = {};
  try {
    r = await fetch(path, { method: opt.method || 'GET', headers: { 'Content-Type': 'application/json', ...(localStorage.token ? { Authorization: 'Bearer ' + localStorage.token } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  } catch { return { ok: false, status: 0, data: { error: 'Cannot reach the server. Check your internet and that the server is running.' } }; }
  try { d = await r.json(); } catch {}
  if (r.status === 401 && localStorage.token && path !== '/api/login') localStorage.removeItem('token');
  return { ok: r.ok, status: r.status, data: d };
}
async function logout() { try { await api('/api/logout', { method: 'POST' }); } catch {} localStorage.clear(); }
const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
function genCode() { const a = crypto.getRandomValues(new Uint8Array(10)); const c = [...a].map((x) => ALPHA[x % ALPHA.length]).join(''); return c.slice(0, 3) + '-' + c.slice(3, 7) + '-' + c.slice(7); }
function normCode(v) {
  v = (v || '').trim(); const h = v.indexOf('#'); if (h >= 0) v = v.slice(h + 1);
  v = v.toLowerCase().replace(/[^a-z0-9]/g, ''); return v.length === 10 ? v.slice(0, 3) + '-' + v.slice(3, 7) + '-' + v.slice(7) : null;
}
async function sha(s) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function toast(msg, ms = 3800) {
  let box = $('toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.append(box); }
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; box.append(t); setTimeout(() => t.remove(), ms);
}
function ago(t) { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; }
const secureOK = () => window.isSecureContext && window.crypto && crypto.subtle;
