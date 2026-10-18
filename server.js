const express = require('express'), http = require('http'), path = require('path'), fs = require('fs'), crypto = require('crypto');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), helmet = require('helmet');
const V = require('./public/validate.js');

const SECRET = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(__dirname, '.jwt_secret');
  try { return fs.readFileSync(f, 'utf8'); }
  catch { const s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, s); return s; }
})();
const MAX = +process.env.MAX_PARTICIPANTS || 6; // mesh video works best up to ~6

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'meetsphere.db'));
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, hash TEXT);
CREATE TABLE IF NOT EXISTS revoked(jti TEXT PRIMARY KEY, exp INTEGER);
CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY, host_id INTEGER, created_at INTEGER)`);
try { db.exec('ALTER TABLE meetings ADD COLUMN ended_at INTEGER'); } catch {}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const bucket = (max, win) => {
  const m = new Map();
  const live = (k) => { const n = Date.now(), a = (m.get(k) || []).filter((t) => n - t < win); m.set(k, a); return a; };
  setInterval(() => { for (const k of [...m.keys()]) if (!live(k).length) m.delete(k); }, 6e5).unref();
  return { ok: (k) => live(k).length < max, hit: (k) => live(k).push(Date.now()), clear: (k) => m.delete(k) };
};
const regB = bucket(+process.env.REG_LIMIT || 10, 36e5), ipFail = bucket(30, 9e5), mailFail = bucket(8, 9e5);
const DUMMY = bcrypt.hashSync('dummy-password-1', 10); // equalises timing for unknown emails
const tooMany = (res) => res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes and try again.' });
setInterval(() => db.prepare('DELETE FROM revoked WHERE exp<?').run(Date.now()), 36e5).unref();

const userFromToken = (t) => {
  try {
    const p = jwt.verify(t, SECRET);
    if (p.jti && db.prepare('SELECT 1 FROM revoked WHERE jti=?').get(p.jti)) return null; // logged-out token
    const u = db.prepare('SELECT id,name FROM users WHERE id=?').get(p.id);
    return u ? { ...u, jti: p.jti } : null;
  } catch { return null; }
};
const authMw = (req, res, next) => {
  const h = req.headers.authorization || '', t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const u = userFromToken(t);
  if (!u) return res.status(401).json({ error: 'Please log in again' });
  req.user = u; req.token = t; next();
};
const sign = (u) => jwt.sign({ id: u.id }, SECRET, { expiresIn: '7d', jwtid: crypto.randomUUID() });
const bad = (res, r) => res.status(400).json({ error: Object.values(r.errors)[0], fields: r.errors });

app.post('/api/register', (req, res) => {
  const r = V.register(req.body || {}); if (!r.ok) return bad(res, r);
  if (!regB.ok(req.ip)) return tooMany(res);
  regB.hit(req.ip);
  try {
    const x = db.prepare('INSERT INTO users(name,email,hash) VALUES(?,?,?)').run(r.values.name, r.values.email, bcrypt.hashSync(r.values.password, 10));
    res.json({ token: sign({ id: x.lastInsertRowid }), name: r.values.name });
  } catch (e) {
    if (/UNIQUE/.test(String(e.code) + String(e.message))) { const m = 'This email is already registered. Try logging in.'; return res.status(409).json({ error: m, fields: { email: m } }); }
    console.error(e); res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});
app.post('/api/login', (req, res) => {
  const r = V.login(req.body || {}); if (!r.ok) return bad(res, r);
  const { email, password } = r.values;
  if (!ipFail.ok(req.ip) || !mailFail.ok(email)) return tooMany(res);
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const good = bcrypt.compareSync(password, u ? u.hash : DUMMY);
  if (!u || !good) { ipFail.hit(req.ip); mailFail.hit(email); return res.status(401).json({ error: 'Wrong email or password' }); }
  mailFail.clear(email);
  res.json({ token: sign(u), name: u.name });
});
app.post('/api/logout', authMw, (req, res) => {
  if (req.user.jti) {
    const p = jwt.decode(req.token);
    db.prepare('INSERT OR IGNORE INTO revoked(jti,exp) VALUES(?,?)').run(req.user.jti, (p.exp || 0) * 1000);
    io.sockets.sockets.forEach((s) => { if (s.jti === req.user.jti) s.disconnect(true); });
  }
  res.json({ ok: true });
});
app.get('/api/me', authMw, (req, res) => res.json({ id: req.user.id, name: req.user.name }));

// Meeting ids are SHA-256 hashes of the meeting code: the server never sees the code itself.
app.post('/api/meetings', authMw, (req, res) => {
  const id = (req.body || {}).id;
  if (!/^[0-9a-f]{64}$/.test(id || '')) return res.status(400).json({ error: 'Invalid meeting' });
  try { db.prepare('INSERT INTO meetings(id,host_id,created_at) VALUES(?,?,?)').run(id, req.user.id, Date.now()); res.json({ ok: true }); }
  catch { res.status(409).json({ error: 'Please try again' }); }
});
app.get('/api/meetings/:id', authMw, (req, res) => {
  const m = db.prepare('SELECT u.name host, m.ended_at FROM meetings m JOIN users u ON u.id=m.host_id WHERE m.id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Meeting not found' });
  if (m.ended_at) return res.status(410).json({ error: 'This meeting has ended' });
  res.json({ ok: true, host: m.host });
});
app.get('/api/ice', authMw, (req, res) => {
  const s = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) s.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  res.json({ iceServers: s });
});

app.use((err, req, res, next) => res.status(err.status && err.status < 500 ? 400 : 500).json({ error: err.status && err.status < 500 ? 'Bad request' : 'Server error' }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 25e6 });
require('./lib/realtime')(io, {
  MAX,
  getUser: userFromToken,
  getMeeting: (id) => db.prepare('SELECT host_id, ended_at FROM meetings WHERE id=?').get(id),
  endMeeting: (id) => db.prepare('UPDATE meetings SET ended_at=? WHERE id=?').run(Date.now(), id),
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MeetSphere running at http://localhost:${PORT}  (max ${MAX} people per meeting)`));
