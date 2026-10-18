// Shared by server (require) and browser (<script>) so both enforce the SAME rules.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.V = factory(); })(this, function () {
  const bytes = (s) => (typeof Buffer !== 'undefined' ? Buffer.byteLength(s) : new TextEncoder().encode(s).length);
  const WEAK = new Set(['password1', 'password123', '12345678', '123456789', 'qwerty123', 'abcd1234', 'iloveyou1', 'admin123', 'welcome1', 'letmein123']);
  const name = (v) => {
    if (typeof v !== 'string') return { err: 'Enter your full name' };
    const s = v.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!s) return { err: 'Enter your full name' };
    if (s.length < 2) return { err: 'Name must be at least 2 characters' };
    if (s.length > 50) return { err: 'Name must be 50 characters or less' };
    if (!/^\p{L}[\p{L}\p{M}\p{N} .'\-]*$/u.test(s)) return { err: "Name can only have letters, numbers, spaces and . ' -" };
    return { v: s };
  };
  const email = (v) => {
    if (typeof v !== 'string' || !v.trim()) return { err: 'Enter your email' };
    const s = v.trim().toLowerCase();
    if (s.length > 254 || s.includes('..') || !/^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,}$/.test(s)) return { err: 'Enter a valid email address' };
    return { v: s };
  };
  const password = (v) => {
    if (typeof v !== 'string' || !v) return { err: 'Enter a password' };
    if (v.length < 8) return { err: 'Password must be at least 8 characters' };
    if (bytes(v) > 72) return { err: 'Password is too long (max 72 bytes)' };
    if (!/\p{L}/u.test(v) || !/\d/.test(v)) return { err: 'Use letters and at least one number' };
    if (WEAK.has(v.toLowerCase())) return { err: 'This password is too common. Choose another' };
    return { v };
  };
  const strength = (v) => { let s = 0; if (v.length >= 8) s++; if (v.length >= 12) s++; if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++; if (/\d/.test(v)) s++; if (/[^A-Za-z0-9]/.test(v)) s++; return Math.min(4, Math.max(0, s - (v.length < 8 ? 1 : 0))); };
  const collect = (parts) => { const errors = {}, values = {}; for (const [k, r] of Object.entries(parts)) r.err ? (errors[k] = r.err) : (values[k] = r.v); return { ok: !Object.keys(errors).length, errors, values }; };
  const register = (b) => collect({ name: name(b.name), email: email(b.email), password: password(b.password) });
  const login = (b) => collect({ email: email(b.email), password: typeof b.password === 'string' && b.password && b.password.length <= 200 ? { v: b.password } : { err: 'Enter your password' } });
  return { name, email, password, strength, register, login };
});
