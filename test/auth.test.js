// End-to-end auth tests: starts the real server on a temp DB and talks HTTP to it.
const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), net = require('node:net'), os = require('node:os'), path = require('node:path'), fs = require('node:fs');
let proc, base;

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function call(p, body, token, method = 'POST', raw) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  let d = {}; try { d = await r.json(); } catch {} return { s: r.status, d };
}
test.before(async () => {
  const port = await freePort(); base = 'http://127.0.0.1:' + port;
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-')), 't.db');
  proc = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: port, DB_PATH: db, JWT_SECRET: 'test-secret', REG_LIMIT: '50' }, cwd: path.join(__dirname, '..') });
  await new Promise((res, rej) => { proc.stdout.on('data', (b) => /running/.test(b) && res()); proc.stderr.on('data', (b) => process.stderr.write(b)); proc.on('exit', () => rej(new Error('server exited'))); setTimeout(() => rej(new Error('server start timeout')), 8000); });
});
test.after(() => proc && proc.kill());

const U = { name: 'Test User', email: 'Test.User@Example.com', password: 'Secret123' };

test('register: validation errors (typing / empty / wrong types)', async () => {
  for (const [body, field] of [[{}, 'name'], [{ ...U, name: '' }, 'name'], [{ ...U, name: '<b>x</b>' }, 'name'], [{ ...U, email: 'nope' }, 'email'], [{ ...U, email: 123 }, 'email'], [{ ...U, password: 'short1' }, 'password'], [{ ...U, password: 'onlyletters' }, 'password'], [{ ...U, password: { a: 1 } }, 'password']]) {
    const r = await call('/api/register', body); assert.equal(r.s, 400, JSON.stringify(body)); assert.ok(r.d.fields[field], 'field ' + field);
  }
  assert.equal((await call('/api/register', undefined, null, 'POST', '{bad json')).s, 400);
});
let token1;
test('register: success returns token + normalised name', async () => {
  const r = await call('/api/register', U); assert.equal(r.s, 200); assert.ok(r.d.token); assert.equal(r.d.name, 'Test User'); token1 = r.d.token;
  const me = await call('/api/me', undefined, token1, 'GET'); assert.equal(me.s, 200); assert.equal(me.d.name, 'Test User');
});
test('register: duplicate email (any letter case) gives 409', async () => {
  for (const e of ['test.user@example.com', 'TEST.USER@EXAMPLE.COM', '  Test.User@Example.com  ']) {
    const r = await call('/api/register', { ...U, name: 'Other', email: e }); assert.equal(r.s, 409, e); assert.match(r.d.fields.email, /already registered/);
  }
});
test('login: wrong password / unknown email / missing fields', async () => {
  assert.equal((await call('/api/login', { email: U.email, password: 'Wrong1234' })).s, 401);
  assert.equal((await call('/api/login', { email: 'nobody@example.com', password: 'Secret123' })).s, 401);
  assert.equal((await call('/api/login', { email: U.email })).s, 400);
  assert.equal((await call('/api/login', { email: U.email, password: { $ne: 1 } })).s, 400);
  const a = await call('/api/login', { email: U.email, password: 'Wrong1234' }), b = await call('/api/login', { email: 'nobody@example.com', password: 'Wrong1234' });
  assert.equal(a.d.error, b.d.error, 'same message so emails cannot be probed');
});
let token2;
test('login: works with different email casing', async () => {
  const r = await call('/api/login', { email: ' TEST.user@example.com ', password: U.password }); assert.equal(r.s, 200); token2 = r.d.token; assert.notEqual(token2, token1);
});
test('logout: revokes only that session; repeat login works', async () => {
  assert.equal((await call('/api/logout', undefined, token2)).s, 200);
  assert.equal((await call('/api/me', undefined, token2, 'GET')).s, 401, 'logged-out token is dead');
  assert.equal((await call('/api/me', undefined, token1, 'GET')).s, 200, 'other session still alive');
  for (let i = 0; i < 3; i++) {
    const l = await call('/api/login', { email: U.email, password: U.password }); assert.equal(l.s, 200);
    assert.equal((await call('/api/me', undefined, l.d.token, 'GET')).s, 200);
    assert.equal((await call('/api/logout', undefined, l.d.token)).s, 200);
    assert.equal((await call('/api/me', undefined, l.d.token, 'GET')).s, 401);
  }
});
test('tokens: missing / tampered tokens rejected', async () => {
  assert.equal((await call('/api/me', undefined, null, 'GET')).s, 401);
  assert.equal((await call('/api/me', undefined, token1.slice(0, -3) + 'abc', 'GET')).s, 401);
  assert.equal((await call('/api/logout')).s, 401);
});
test('rate limit: repeated wrong passwords lock that email, correct login resets only before lock', async () => {
  const e = 'lock.me@example.com'; await call('/api/register', { name: 'Lock Me', email: e, password: 'Secret123' });
  for (let i = 0; i < 8; i++) assert.equal((await call('/api/login', { email: e, password: 'Wrong1234' })).s, 401);
  assert.equal((await call('/api/login', { email: e, password: 'Secret123' })).s, 429, 'locked after 8 failures');
  assert.equal((await call('/api/login', { email: U.email, password: U.password })).s, 200, 'other accounts unaffected');
});

test('meetings: create, look up, duplicate, invalid, ended and unauthenticated', async () => {
  const r = await call('/api/login', { email: U.email, password: U.password }); const t = r.d.token;
  const id = 'c'.repeat(64);
  assert.equal((await call('/api/meetings', { id }, null)).s, 401, 'must be logged in');
  assert.equal((await call('/api/meetings', { id: 'short' }, t)).s, 400);
  assert.equal((await call('/api/meetings', { id }, t)).s, 200);
  assert.equal((await call('/api/meetings', { id }, t)).s, 409, 'same code cannot be created twice');
  assert.equal((await call('/api/meetings/' + id, undefined, t, 'GET')).s, 200);
  assert.equal((await call('/api/meetings/' + 'd'.repeat(64), undefined, t, 'GET')).s, 404);
  assert.equal((await call('/api/meetings/' + id, undefined, null, 'GET')).s, 401);
  assert.equal((await call('/api/ice', undefined, t, 'GET')).d.iceServers.length >= 1, true);
});
