// Tests lib/realtime.js (rooms, host controls, limits) with an in-memory fake of Socket.IO. No server needed.
const test = require('node:test'), assert = require('node:assert/strict');
const setup = require('../lib/realtime.js');

function makeIO() {
  const mw = [], conns = [], sockets = new Map(), rooms = new Map(); let n = 0;
  const io = {
    use: (f) => mw.push(f), on: (ev, f) => ev === 'connection' && conns.push(f), sockets: { sockets, adapter: { rooms } },
    to(r) { return { emit: (ev, ...a) => [...(rooms.get(r) || [])].forEach((id) => sockets.get(id) && sockets.get(id).emit(ev, ...a)) }; },
  };
  class S {
    constructor(token) { this.id = 's' + ++n; this.handshake = { auth: { token } }; this.h = {}; this.client = { ev: [], on: {} }; }
    on(ev, f) { this.h[ev] = f; }
    emit(ev, ...a) { this.client.ev.push([ev, ...a]); (this.client.on[ev] || []).forEach((f) => f(...a)); }
    join(r) { if (!rooms.has(r)) rooms.set(r, new Set()); rooms.get(r).add(this.id); }
    leave(r) { const s = rooms.get(r); if (s) { s.delete(this.id); if (!s.size) rooms.delete(r); } }
    to(r) { return { emit: (ev, ...a) => [...(rooms.get(r) || [])].forEach((id) => id !== this.id && sockets.get(id).emit(ev, ...a)) }; }
    disconnect() { this.h.disconnecting && this.h.disconnecting(); if (this.room) this.leave(this.room); sockets.delete(this.id); }
  }
  io.connect = (token) => { const s = new S(token); let err; mw.forEach((f) => f(s, (e) => e && (err = e))); if (err) return { error: err.message }; sockets.set(s.id, s); conns.forEach((f) => f(s)); return s; };
  return io;
}
const ID = 'a'.repeat(64), users = { t1: { id: 1, name: 'Host' }, t2: { id: 2, name: 'Guest' }, t3: { id: 3, name: 'Third' }, t4: { id: 4, name: 'Fourth' } };
function boot(max = 3) {
  const io = makeIO(), meetings = new Map([[ID, { host_id: 1 }]]);
  setup(io, { MAX: max, getUser: (t) => users[t] || null, getMeeting: (id) => meetings.get(id), endMeeting: (id) => (meetings.get(id).ended_at = 1) });
  const join = (tok) => { const s = io.connect(tok); let res; s.h.join({ id: ID }, (r) => (res = r)); return { s, res }; };
  return { io, meetings, join };
}

test('rejects unauthenticated sockets', () => assert.equal(boot().io.connect('bad').error, 'unauthorized'));
test('join: invalid id / unknown meeting', () => {
  const { io } = boot(); const s = io.connect('t1'); let r;
  s.h.join({ id: 'zzz' }, (x) => (r = x)); assert.match(r.error, /Invalid/);
  s.h.join({ id: 'b'.repeat(64) }, (x) => (r = x)); assert.match(r.error, /not found/);
});
test('host is identified by account, guest is not', () => {
  const { join } = boot(); const h = join('t1'), g = join('t2');
  assert.equal(h.res.you.host, true); assert.equal(g.res.you.host, false);
  assert.equal(g.res.peers.length, 1); assert.equal(g.res.peers[0].host, true);
  assert.ok(h.s.client.ev.some(([e, p]) => e === 'peer-joined' && p.name === 'Guest'));
});
test('capacity: the 4th person is refused when MAX=3', () => {
  const { join } = boot(3); join('t1'); join('t2'); join('t3'); assert.match(join('t4').res.error, /full/);
});
test('chat: only binary ciphertext is accepted and relayed; late joiners get history', () => {
  const { join } = boot(); const h = join('t1'), g = join('t2'); let ok;
  g.s.h.chat('plaintext string', (x) => (ok = x)); assert.equal(ok, false);
  g.s.h.chat(Buffer.from([1, 2, 3]), (x) => (ok = x)); assert.equal(ok, true);
  assert.ok(h.s.client.ev.some(([e, m]) => e === 'chat' && m.name === 'Guest'));
  assert.equal(join('t3').res.chat.length, 1);
});
test('state (mic/cam/hand/sharing) is broadcast to others', () => {
  const { join } = boot(); const h = join('t1'), g = join('t2');
  g.s.h.state({ mic: false, cam: true, hand: true, sharing: true });
  const m = h.s.client.ev.filter(([e]) => e === 'state').pop()[1]; assert.deepEqual([m.mic, m.hand, m.sharing], [false, true, true]);
});
test('host-only: guest cannot mute, remove or end', () => {
  const { join, meetings } = boot(); const h = join('t1'), g = join('t2');
  g.s.h.host({ action: 'mute', to: h.s.id }); g.s.h.host({ action: 'remove', to: h.s.id }); g.s.h.host({ action: 'end' });
  assert.ok(!h.s.client.ev.some(([e]) => ['force-mute', 'removed', 'ended'].includes(e))); assert.ok(!meetings.get(ID).ended_at);
});
test('host mutes a guest; host cannot target themselves', () => {
  const { join } = boot(); const h = join('t1'), g = join('t2');
  h.s.h.host({ action: 'mute', to: g.s.id }); assert.ok(g.s.client.ev.some(([e]) => e === 'force-mute'));
  h.s.h.host({ action: 'remove', to: h.s.id }); assert.equal(h.s.room, ID);
});
test('host removes a guest: they are told, others see them leave, and they cannot rejoin', () => {
  const { join, io } = boot(); const h = join('t1'), g = join('t2');
  h.s.h.host({ action: 'remove', to: g.s.id });
  assert.ok(g.s.client.ev.some(([e]) => e === 'removed')); assert.ok(h.s.client.ev.some(([e, id]) => e === 'peer-left' && id === g.s.id));
  const again = io.connect('t2'); let r; again.h.join({ id: ID }, (x) => (r = x)); assert.match(r.error, /removed/);
});
test('host ends the meeting: everyone is notified, meeting is closed, nobody can join', () => {
  const { join, io, meetings } = boot(); const h = join('t1'), g = join('t2');
  h.s.h.host({ action: 'end' });
  assert.ok(g.s.client.ev.some(([e]) => e === 'ended')); assert.ok(meetings.get(ID).ended_at);
  const late = io.connect('t3'); let r; late.h.join({ id: ID }, (x) => (r = x)); assert.match(r.error, /ended/);
});
test('disconnect tells the room; whiteboard strokes are sanitised and replayed', () => {
  const { join } = boot(); const h = join('t1'), g = join('t2');
  g.s.h.draw({ x0: -5, y0: 9, x1: 0.5, y1: 0.5, c: 'javascript:alert(1)', w: 999, e: 1 });
  const d = h.s.client.ev.filter(([e]) => e === 'draw').pop()[1]; assert.deepEqual([d.x0, d.y0, d.c, d.w, d.e], [0, 1, '#000000', 60, true]);
  assert.equal(join('t3').res.board.length, 1);
  g.s.disconnect(); assert.ok(h.s.client.ev.some(([e, id]) => e === 'peer-left' && id === g.s.id));
});
