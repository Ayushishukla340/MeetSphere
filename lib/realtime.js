// All Socket.IO room / signalling logic lives here so it can be tested without a real server.
module.exports = function setupRealtime(io, deps) {
  const { getUser, getMeeting, endMeeting, MAX = 6 } = deps;
  const rooms = new Map(); // roomId -> { board:[], chat:[], banned:Set }  (chat holds ciphertext only)
  const info = (x) => ({ id: x.id, name: x.user.name, host: !!x.host, ...x.st });
  const num = (v) => Math.max(0, Math.min(1, +v || 0));
  const members = (id) => [...(io.sockets.adapter.rooms.get(id) || [])].map((x) => io.sockets.sockets.get(x)).filter(Boolean);

  io.use((s, next) => {
    const u = getUser(s.handshake.auth && s.handshake.auth.token);
    if (!u) return next(new Error('unauthorized'));
    s.user = u; s.jti = u.jti; next();
  });

  io.on('connection', (s) => {
    s.st = { mic: true, cam: true, hand: false, sharing: false };

    s.on('join', (d, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      const id = d && d.id;
      if (!/^[0-9a-f]{64}$/.test(id || '')) return cb({ error: 'Invalid meeting' });
      const m = getMeeting(id);
      if (!m) return cb({ error: 'Meeting not found. Check the code.' });
      if (m.ended_at) return cb({ error: 'This meeting has ended.' });
      const R0 = rooms.get(id);
      if (R0 && R0.banned.has(s.user.id)) return cb({ error: 'You were removed from this meeting by the host.' });
      const others = members(id).filter((x) => x.id !== s.id);
      if (others.length >= MAX) return cb({ error: `Meeting is full (max ${MAX} people)` });
      if (s.room) s.leave(s.room);
      s.join(id); s.room = id; s.host = m.host_id === s.user.id;
      s.st = { mic: true, cam: true, hand: false, sharing: false };
      const R = R0 || { board: [], chat: [], banned: new Set() }; rooms.set(id, R);
      s.to(id).emit('peer-joined', info(s));
      cb({ ok: true, you: info(s), peers: others.map(info), board: R.board, chat: R.chat });
    });

    // WebRTC signalling relay (offer / answer / ICE)
    s.on('signal', ({ to, data } = {}) => {
      const t = io.sockets.sockets.get(to);
      if (t && s.room && t.room === s.room) t.emit('signal', { from: s.id, name: s.user.name, data });
    });
    s.on('state', (st = {}) => {
      if (!s.room) return;
      s.st = { mic: !!st.mic, cam: !!st.cam, hand: !!st.hand, sharing: !!st.sharing };
      s.to(s.room).emit('state', { id: s.id, ...s.st });
    });
    s.on('chat', (p, cb) => {
      const R = rooms.get(s.room);
      if (!R || !Buffer.isBuffer(p) || p.length > 20000) return cb && cb(false);
      const m = { name: s.user.name, p, t: Date.now() };
      R.chat.push(m); if (R.chat.length > 100) R.chat.shift();
      s.to(s.room).emit('chat', m); cb && cb(true);
    });
    s.on('file', (d, cb) => {
      if (!s.room || !d || !Buffer.isBuffer(d.meta) || !Buffer.isBuffer(d.data) || d.data.length > 22e6 || d.meta.length > 2000) return cb && cb(false);
      s.to(s.room).emit('file', { name: s.user.name, t: Date.now(), meta: d.meta, data: d.data }); cb && cb(true);
    });
    s.on('draw', (d) => {
      const R = rooms.get(s.room); if (!R || !d) return;
      const l = { x0: num(d.x0), y0: num(d.y0), x1: num(d.x1), y1: num(d.y1), c: /^#[0-9a-f]{6}$/i.test(d.c) ? d.c : '#000000', w: Math.max(1, Math.min(60, +d.w || 3)), e: !!d.e };
      R.board.push(l); if (R.board.length > 30000) R.board.shift();
      s.to(s.room).emit('draw', l);
    });
    s.on('clear', () => { const R = rooms.get(s.room); if (R) { R.board = []; s.to(s.room).emit('clear'); } });

    // Host controls: mute one person, remove one person, or end the meeting for everyone
    s.on('host', ({ action, to } = {}) => {
      if (!s.host || !s.room) return;
      const room = s.room;
      if (action === 'end') {
        io.to(room).emit('ended');
        endMeeting(room); rooms.delete(room);
        members(room).forEach((t) => { t.leave(room); t.room = null; });
        return;
      }
      const t = io.sockets.sockets.get(to);
      if (!t || t.room !== room || t.id === s.id) return;
      if (action === 'mute') t.emit('force-mute');
      if (action === 'remove') {
        const R = rooms.get(room); if (R) R.banned.add(t.user.id);
        t.emit('removed'); t.leave(room); t.room = null; io.to(room).emit('peer-left', t.id);
      }
    });

    s.on('disconnecting', () => {
      const r = s.room; if (!r) return;
      s.to(r).emit('peer-left', s.id);
      setTimeout(() => { if (!io.sockets.adapter.rooms.get(r)) rooms.delete(r); }, 1000).unref();
    });
  });
};
