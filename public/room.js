(async () => {
const VID = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } };
const code = normCode(location.hash);
const loginUrl = '/?next=' + encodeURIComponent('/room.html' + location.hash);
if (!localStorage.token) { location = loginUrl; return; }
if (!code) { location = '/'; return; }
$('code').textContent = code; $('topcode').textContent = code; $('pcode').textContent = code;
const lmsg = (t) => ($('lmsg').textContent = t);
if (!secureOK()) { lmsg('⚠️ Camera, mic and encryption only work on https:// or http://localhost. Open the https link (see README).'); return; }
const me = await api('/api/me');
if (!me.ok) { location = loginUrl; return; }
$('lname').textContent = me.data.name; $('pvl').textContent = me.data.name[0].toUpperCase();

// ---- keys: meeting id = SHA-256(code); AES key = PBKDF2(code). Server never sees the code ----
const roomId = await sha('id:' + code);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new TextEncoder().encode('meetsphere-v1'), iterations: 100000, hash: 'SHA-256' },
  await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const enc = async (d) => { const iv = crypto.getRandomValues(new Uint8Array(12)); const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, d)); const o = new Uint8Array(12 + c.length); o.set(iv); o.set(c, 12); return o.buffer; };
const dec = async (b) => { const u = new Uint8Array(b); return crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, key, u.slice(12)); };
const encT = (t) => enc(new TextEncoder().encode(t)), decT = async (b) => new TextDecoder().decode(await dec(b));

const mc = await api('/api/meetings/' + roomId);
if (!mc.ok) { lmsg(mc.status === 410 ? '🚫 This meeting has ended. Ask the host for a new code.' : '❌ Meeting not found. Check the code and try again.'); return; }
const ice = await api('/api/ice');
const iceServers = ice.ok ? ice.data.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }];

// ---- state ----
let media = { a: null, v: null }, micOn = true, camOn = true, screenTrack = null, handUp = false;
let inCall = false, leaving = false;
let socket = null, myId = null, isHost = false, people = {}, peers = {}, joinedAt = 0, curTab = 'chat', unread = 0;

// ---- camera / mic ----
function mediaMsg(errs) {
  const e = errs[0]; if (!e) return '';
  if (e === 'NotAllowedError') return '🚫 Camera/mic permission is blocked. Click the 🔒 icon in the address bar → Allow, then press Retry.';
  if (e === 'NotReadableError') return '📷 Camera is being used by another app/tab/browser. Close it and press Retry. (Tip: test with a phone or a second device.)';
  if (e === 'NotFoundError') return 'No camera/mic found. You can still join and see/hear others.';
  return 'Could not start camera/mic (' + e + '). You can still join.';
}
async function getMedia() {
  [media.a, media.v].forEach((t) => t && (t.onended = null, t.stop())); media.a = media.v = null;
  const errs = [], tryGet = async (c) => { try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) { errs.push(e.name); return null; } };
  let s = await tryGet({ audio: true, video: VID });
  if (!s) { const v = await tryGet({ video: VID }), a = await tryGet({ audio: true }); s = new MediaStream([...(v ? v.getTracks() : []), ...(a ? a.getTracks() : [])]); }
  media.a = s.getAudioTracks()[0] || null; media.v = s.getVideoTracks()[0] || null;
  if (media.a) { media.a.enabled = micOn; media.a.onended = () => { media.a = null; toast('Microphone stopped. Press 🎤 to retry.'); afterMediaChange(); }; }
  if (media.v) { media.v.enabled = camOn; media.v.onended = () => { media.v = null; toast('Camera stopped (another app/tab may be using it). Press 📷 to retry.'); afterMediaChange(); }; }
  return mediaMsg(errs);
}
const outV = () => screenTrack || media.v;
function afterMediaChange() { if (socket) { pushTracks(); refreshLocal(); sendState(); updateBtns(); } else updateLobby(); }
function updateLobby() {
  $('pv').srcObject = media.v ? new MediaStream([media.v]) : null;
  $('pvbox').classList.toggle('nocam', !(media.v && camOn));
  $('lmic').classList.toggle('off', !(media.a && micOn)); $('lcam').classList.toggle('off', !(media.v && camOn));
}
async function retry() { lmsg('Trying…'); const m = await getMedia(); lmsg(m); updateLobby(); if (socket) afterMediaChange(); }
$('retry').onclick = retry;
$('lmic').onclick = () => { if (!media.a) return retry(); micOn = !micOn; media.a.enabled = micOn; updateLobby(); };
$('lcam').onclick = () => { if (!media.v) return retry(); camOn = !camOn; media.v.enabled = camOn; updateLobby(); };
const mediaReady = getMedia().then((m) => { lmsg(m); updateLobby(); });
$('joinBtn').disabled = false;
$('joinBtn').onclick = async () => { $('joinBtn').disabled = true; await mediaReady; $('lobby').classList.add('hide'); $('call').classList.remove('hide'); inCall = true; history.pushState({ ms: 1 }, '', location.href); startCall(); };

// ---- WebRTC peers ----
const senderOf = (pc, kind) => { const t = pc.getTransceivers().find((x) => x.receiver && x.receiver.track && x.receiver.track.kind === kind); return t && t.sender; };
// Screen shares need sharp text: keep resolution, allow more bitrate. Camera keeps the normal balanced mode.
async function tune(sender, screen) {
  try {
    const p = sender.getParameters(); if (!p.encodings || !p.encodings.length) return;
    p.encodings[0].maxBitrate = screen ? 2500000 : 1000000; p.degradationPreference = screen ? 'maintain-resolution' : 'balanced';
    await sender.setParameters(p);
  } catch (e) { /* not negotiated yet: tuned on the next change */ }
}
async function attach(p) {
  for (const [k, t] of [['audio', media.a], ['video', outV()]]) {
    const s = senderOf(p.pc, k); if (!s) continue;
    try { await s.replaceTrack(t); if (k === 'video') await tune(s, !!screenTrack); } catch (e) { console.warn(e); }
  }
}
const pushTracks = () => Object.values(peers).forEach(attach);
function makePeer(id, initiator) {
  const pc = new RTCPeerConnection({ iceServers });
  const p = { pc, queue: [], ready: false, stream: new MediaStream() };
  peers[id] = p;
  pc.onicecandidate = (e) => e.candidate && socket.emit('signal', { to: id, data: { ice: e.candidate } });
  pc.ontrack = (e) => { p.stream.addTrack(e.track); const v = ensureTile(id).querySelector('video'); if (v.srcObject !== p.stream) v.srcObject = p.stream; v.play().catch(() => toast('Tap anywhere on the screen to start video/sound')); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') toast('Connection to ' + ((people[id] || {}).name || 'a participant') + ' failed. Network may need a TURN server (see README).', 7000); };
  if (initiator) { pc.addTransceiver('audio', { direction: 'sendrecv' }); pc.addTransceiver('video', { direction: 'sendrecv' }); }
  return p;
}
function closePeer(id) { const p = peers[id]; if (p) { try { p.pc.close(); } catch {} delete peers[id]; } }
async function callPeer(id) {
  const p = makePeer(id, true); await attach(p);
  await p.pc.setLocalDescription(await p.pc.createOffer());
  socket.emit('signal', { to: id, data: { sdp: p.pc.localDescription } });
}
const flush = async (p) => { p.ready = true; for (const c of p.queue.splice(0)) try { await p.pc.addIceCandidate(c); } catch {} };
async function onSignal({ from, name, data }) {
  if (!people[from]) addPerson({ id: from, name: name || 'Guest', mic: true, cam: true, hand: false, sharing: false });
  try {
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        closePeer(from); const p = makePeer(from, false);
        await p.pc.setRemoteDescription(data.sdp); await flush(p);
        p.pc.getTransceivers().forEach((t) => { try { t.direction = 'sendrecv'; } catch {} });
        await attach(p);
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        socket.emit('signal', { to: from, data: { sdp: p.pc.localDescription } });
      } else if (peers[from]) { await peers[from].pc.setRemoteDescription(data.sdp); await flush(peers[from]); }
    } else if (data.ice && peers[from]) {
      const p = peers[from]; if (p.ready) { try { await p.pc.addIceCandidate(data.ice); } catch {} } else p.queue.push(data.ice);
    }
  } catch (e) { console.error('signal error', e); }
}

// ---- people & tiles ----
function ensureTile(id) {
  let t = $('t-' + id); if (t) return t;
  t = document.createElement('div'); t.className = 'tile' + (id === myId ? ' me' : ''); t.id = 't-' + id;
  t.innerHTML = '<video autoplay playsinline></video><div class="av"><b></b></div><div class="tag"><span class="mi"></span><span class="nm"></span></div><div class="hand">✋</div>';
  if (id === myId) t.querySelector('video').muted = true;
  t.onclick = () => pin(id); $('grid').append(t); return t;
}
function pin(id) {
  const t = $('t-' + id); if (!t) return; const was = t.classList.contains('pin');
  document.querySelectorAll('.tile.pin').forEach((x) => x.classList.remove('pin')); if (!was) t.classList.add('pin'); $('grid').classList.toggle('haspin', !was);
}
function updateTile(id) {
  const p = people[id], t = $('t-' + id); if (!p || !t) return;
  t.querySelector('.nm').textContent = p.name + (id === myId ? ' (You)' : '') + (p.host ? ' · Host' : ''); t.querySelector('.mi').textContent = p.mic ? '' : '🔇';
  t.querySelector('.av b').textContent = (p.name || '?')[0].toUpperCase();
  t.classList.toggle('nocam', !(p.cam || p.sharing)); t.classList.toggle('screen', !!p.sharing); t.classList.toggle('hand-up', !!p.hand);
}
function addPerson(p) { people[p.id] = Object.assign(people[p.id] || {}, p); ensureTile(p.id); updateTile(p.id); renderPeople(); }
function removePerson(id) {
  const p = people[id]; closePeer(id); const t = $('t-' + id);
  if (t) { if (t.classList.contains('pin')) $('grid').classList.remove('haspin'); t.remove(); }
  delete people[id]; renderPeople(); if (p) { toast(p.name + ' left'); sysMsg(p.name + ' left'); }
}
const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
function renderPeople() {
  const box = $('plist'); box.innerHTML = '';
  Object.values(people).forEach((p) => {
    const r = mk('div', 'pr'), nm = mk('div', 'pn', p.name + (p.id === myId ? ' (You)' : '')); if (p.host) nm.append(mk('small', '', 'Host'));
    r.append(mk('div', 'pav', (p.name || '?')[0].toUpperCase()), nm, mk('div', 'pi', (p.hand ? '✋ ' : '') + (p.mic ? '🎤' : '🔇') + ' ' + (p.cam || p.sharing ? '📷' : '🚫')));
    if (isHost && p.id !== myId) {
      const m = mk('button', 'btn ghost sm', 'Mute'), x = mk('button', 'btn ghost sm', 'Remove');
      m.onclick = () => socket.emit('host', { action: 'mute', to: p.id }); x.onclick = () => confirm('Remove ' + p.name + '?') && socket.emit('host', { action: 'remove', to: p.id });
      r.append(m, x);
    }
    box.append(r);
  });
  $('pcount').textContent = Object.keys(people).length;
}
function refreshLocal() {
  if (!myId) return; const v = ensureTile(myId).querySelector('video'), tr = outV();
  v.srcObject = tr ? new MediaStream([tr]) : null; v.play().catch(() => {}); updateTile(myId);
}
const stateNow = () => ({ mic: micOn && !!media.a, cam: camOn && !!media.v, hand: handUp, sharing: !!screenTrack });
function sendState() { if (!socket || !myId) return; const st = stateNow(); Object.assign(people[myId] || {}, st); updateTile(myId); renderPeople(); socket.emit('state', st); }
function updateBtns() {
  const s = stateNow(); $('mic').classList.toggle('off', !s.mic); $('cam').classList.toggle('off', !s.cam);
  $('scr').classList.toggle('on', s.sharing); $('hand').classList.toggle('on', s.hand);
}

// ---- call lifecycle ----
function startCall() {
  socket = io({ auth: { token: localStorage.token }, reconnectionDelay: 800 });
  socket.on('connect', () => { $('conn').classList.add('hide'); doJoin(); });
  socket.on('disconnect', () => { $('conn').classList.remove('hide'); });
  socket.on('connect_error', (e) => { if (e.message === 'unauthorized') { localStorage.removeItem('token'); location = loginUrl; } else $('conn').classList.remove('hide'); });
  socket.on('peer-joined', (p) => { addPerson(p); toast(p.name + ' joined'); sysMsg(p.name + ' joined'); });
  socket.on('peer-left', removePerson);
  socket.on('signal', onSignal);
  socket.on('state', (d) => {
    const prev = people[d.id] || {}; addPerson(d);
    if (d.sharing && !prev.sharing && d.id !== myId) pin(d.id);
    if (!d.sharing && prev.sharing && $('t-' + d.id) && $('t-' + d.id).classList.contains('pin')) pin(d.id);
  });
  socket.on('chat', async (m) => { let text; try { text = await decT(m.p); } catch { text = '🔒 (could not decrypt)'; } addMsg({ name: m.name, text, t: m.t }); });
  socket.on('file', async (m) => {
    try { const meta = JSON.parse(await decT(m.meta)), blob = new Blob([await dec(m.data)], { type: meta.type || 'application/octet-stream' }); addFileMsg(m.name, meta, blob, m.t, false); }
    catch { addMsg({ name: m.name, text: '🔒 (could not decrypt file)', t: m.t }); }
  });
  socket.on('draw', (d) => { strokes.push(d); paint(d); });
  socket.on('clear', () => { strokes = []; clearCv(); });
  socket.on('force-mute', () => { micOn = false; if (media.a) media.a.enabled = false; toast('The host muted you'); sendState(); updateBtns(); });
  socket.on('removed', () => { toast('The host removed you from the meeting', 5000); setTimeout(leave, 1800); });
  socket.on('ended', () => { toast('The host ended the meeting', 5000); setTimeout(leave, 1800); });
}
function doJoin() {
  socket.emit('join', { id: roomId }, async (res) => {
    if (!res || res.error) { toast((res && res.error) || 'Could not join', 5000); return setTimeout(() => (location = '/'), 2500); }
    Object.keys(peers).forEach(closePeer); $('grid').innerHTML = ''; $('grid').classList.remove('haspin'); people = {};
    myId = res.you.id; isHost = res.you.host;
    [res.you, ...res.peers].forEach(addPerson); refreshLocal();
    strokes = res.board; redraw();
    $('msgs').innerHTML = ''; for (const m of res.chat) { let text; try { text = await decT(m.p); } catch { text = '🔒 (could not decrypt)'; } addMsg({ name: m.name === me.data.name ? 'You' : m.name, text, t: m.t, me: m.name === me.data.name, quiet: true }); }
    sysMsg('You joined the meeting');
    res.peers.forEach((p) => callPeer(p.id)); sendState(); updateBtns();
    if (!joinedAt) { joinedAt = Date.now(); setInterval(tick, 1000); }
  });
}
function tick() { const s = Math.floor((Date.now() - joinedAt) / 1000), h = Math.floor(s / 3600), m = String(Math.floor((s % 3600) / 60)).padStart(2, '0'), x = String(s % 60).padStart(2, '0'); $('timer').textContent = (h ? h + ':' : '') + m + ':' + x; }
function leave() { leaving = true; inCall = false; try { [media.a, media.v, screenTrack].forEach((t) => t && t.stop()); Object.keys(peers).forEach(closePeer); socket && socket.disconnect(); } catch {} location = '/'; }


// ---- controls ----
$('mic').onclick = () => { if (!media.a) return retry(); micOn = !micOn; media.a.enabled = micOn; sendState(); updateBtns(); };
$('cam').onclick = () => { if (!media.v) return retry(); camOn = !camOn; media.v.enabled = camOn; sendState(); updateBtns(); };
$('hand').onclick = () => { handUp = !handUp; sendState(); updateBtns(); if (handUp) toast('Hand raised ✋'); };
$('scr').onclick = async () => {
  if (screenTrack) return stopScreen();
  if (!navigator.mediaDevices.getDisplayMedia) return toast('Screen sharing is not supported on this device');
  try { const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); screenTrack = s.getVideoTracks()[0]; try { screenTrack.contentHint = 'detail'; } catch {} screenTrack.onended = stopScreen; afterMediaChange(); }
  catch (e) { if (e.name !== 'NotAllowedError') toast('Could not start screen sharing'); }
};
function stopScreen() { if (!screenTrack) return; screenTrack.stop(); screenTrack = null; afterMediaChange(); }
const flash = () => { const l = location.origin + '/room.html#' + code; return l; };
$('codeBtn').onclick = () => { navigator.clipboard.writeText(flash()); toast('Invite link copied'); };
$('cpc').onclick = () => { navigator.clipboard.writeText(code); toast('Code copied'); }; $('cpl').onclick = $('codeBtn').onclick;

// ---- side panel ----
function showTab(t) {
  curTab = t; $('stitle').textContent = t === 'chat' ? 'Chat' : 'People'; $('tabChat').classList.toggle('on', t === 'chat'); $('tabPeople').classList.toggle('on', t === 'people');
  $('chatP').classList.toggle('hide', t !== 'chat'); $('peopleP').classList.toggle('hide', t !== 'people');
  if (t === 'chat') { unread = 0; $('bd').classList.add('hide'); $('msgs').scrollTop = 1e9; }
}
const sideOpen = () => !$('side').classList.contains('hide');
function closePanel() { $('side').classList.add('hide'); setTimeout(fit, 60); }
function openPanel(t) { const s = $('side'); if (!s.classList.contains('hide') && curTab === t) s.classList.add('hide'); else { s.classList.remove('hide'); showTab(t); } setTimeout(fit, 60); }
$('sideClose').onclick = closePanel; $('sideX').onclick = closePanel;
$('chatB').onclick = () => openPanel('chat'); $('ppl').onclick = () => openPanel('people'); $('tabChat').onclick = () => showTab('chat'); $('tabPeople').onclick = () => showTab('people');

// ---- chat & files ----
const hm = (t) => new Date(t || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function bump(quiet) { if (quiet) return; const closed = $('side').classList.contains('hide') || curTab !== 'chat'; if (closed) { unread++; $('bd').textContent = unread; $('bd').classList.remove('hide'); } else $('msgs').scrollTop = 1e9; }
function addMsg({ name, text, t, me, quiet }) {
  const d = mk('div', 'm' + (me ? ' me' : '')); d.append(mk('b', '', name), mk('small', '', hm(t)), mk('div', '', text)); $('msgs').append(d); $('msgs').scrollTop = 1e9; bump(quiet || me);
}
function sysMsg(t) { $('msgs').append(mk('div', 'm sys', t)); $('msgs').scrollTop = 1e9; }
function addFileMsg(name, meta, blob, t, mine) {
  const d = mk('div', 'm' + (mine ? ' me' : '')), url = URL.createObjectURL(blob), a = mk('a', '', '📎 ' + meta.name + ' (' + (meta.size / 1024).toFixed(1) + ' KB)');
  a.href = url; a.download = meta.name; d.append(mk('b', '', name), mk('small', '', hm(t)), mk('br'), a);
  if (/^image\/(png|jpe?g|gif|webp)$/.test(meta.type)) { const im = mk('img'); im.src = url; d.append(im); }
  $('msgs').append(d); $('msgs').scrollTop = 1e9; bump(mine);
}
async function sendChat() {
  const v = $('txt').value.trim(); if (!v) return;
  if (!socket || !socket.connected) return toast('Not connected. Please wait…');
  socket.emit('chat', await encT(v), (ok) => { if (!ok) toast('Message could not be sent'); });
  addMsg({ name: 'You', text: v, t: Date.now(), me: true }); $('txt').value = '';
}
$('send').onclick = sendChat; $('txt').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
$('fbtn').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  if (f.size > 20e6) return toast('Max file size is 20 MB'); if (!socket || !socket.connected) return toast('Not connected');
  toast('Sending ' + f.name + '…');
  const meta = { name: f.name, type: f.type, size: f.size };
  socket.emit('file', { meta: await encT(JSON.stringify(meta)), data: await enc(await f.arrayBuffer()) }, (ok) => toast(ok ? f.name + ' sent ✓' : 'File could not be sent'));
  addFileMsg('You', meta, f, Date.now(), true);
};

// ---- whiteboard ----
const cv = $('board'), ctx = cv.getContext('2d'); let strokes = [], erase = false, drawing = false, last = null;
const boardOpen = () => !$('boardWrap').classList.contains('hide');
function paint(d) {
  if (!cv.width) return; ctx.strokeStyle = d.c; ctx.lineWidth = d.w; ctx.lineCap = 'round'; ctx.globalCompositeOperation = d.e ? 'destination-out' : 'source-over';
  ctx.beginPath(); ctx.moveTo(d.x0 * cv.width, d.y0 * cv.height); ctx.lineTo(d.x1 * cv.width, d.y1 * cv.height); ctx.stroke();
}
const clearCv = () => ctx.clearRect(0, 0, cv.width, cv.height);
function redraw() { clearCv(); strokes.forEach(paint); }
function fit() { if (!boardOpen()) return; const r = cv.parentElement.getBoundingClientRect(); cv.width = r.width; cv.height = r.height; redraw(); }
const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
cv.onpointerdown = (e) => { drawing = true; last = pos(e); cv.setPointerCapture(e.pointerId); };
cv.onpointermove = (e) => {
  if (!drawing) return; const p = pos(e), d = { x0: last.x, y0: last.y, x1: p.x, y1: p.y, c: $('col').value, w: +$('wd').value * (erase ? 4 : 1), e: erase };
  strokes.push(d); paint(d); socket.emit('draw', d); last = p;
};
cv.onpointerup = cv.onpointercancel = () => { drawing = false; };
$('er').onclick = () => { erase = !erase; $('er').textContent = erase ? 'Pen' : 'Eraser'; };
$('clr').onclick = () => { if (!confirm('Clear the whiteboard for everyone?')) return; strokes = []; clearCv(); socket.emit('clear'); };
$('dl').onclick = () => { const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(cv, 0, 0); const a = document.createElement('a'); a.download = 'whiteboard.png'; a.href = c.toDataURL('image/png'); a.click(); };
$('wb').onclick = () => { $('boardWrap').classList.toggle('hide'); $('wb').classList.toggle('on', boardOpen()); fit(); };
addEventListener('resize', fit);

// ---- leave dialog, Back button, accidental close, mobile helpers ----
const leaveOpen = () => !$('leaveDlg').classList.contains('hide');
function openLeave() {
  $('endAll').classList.toggle('hide', !isHost);
  $('leaveTxt').textContent = isHost ? 'You are the host. You can leave and let the others continue, or end the meeting for everyone.' : 'You will be disconnected from the call.';
  $('leaveDlg').classList.remove('hide');
}
const closeLeave = () => $('leaveDlg').classList.add('hide');
$('end').onclick = openLeave; $('stayBtn').onclick = closeLeave; $('leaveBtn').onclick = leave;
$('endAll').onclick = () => { socket.emit('host', { action: 'end' }); toast('Ending the meeting…'); setTimeout(leave, 400); };
$('leaveDlg').addEventListener('click', (e) => { if (e.target === $('leaveDlg')) closeLeave(); });
document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; if (leaveOpen()) closeLeave(); else if (sideOpen()) closePanel(); });
// Browser/phone Back: close the chat panel first; otherwise ask before leaving (never silently end the meeting)
addEventListener('popstate', () => {
  if (!inCall || leaving) return;
  history.pushState({ ms: 1 }, '', location.href);
  if (leaveOpen()) closeLeave(); else if (sideOpen()) closePanel(); else openLeave();
});
addEventListener('beforeunload', (e) => { if (inCall && !leaving) { e.preventDefault(); e.returnValue = ''; } });
addEventListener('pagehide', () => { try { socket && socket.disconnect(); } catch {} });
// Phones: keep the chat box above the on-screen keyboard; hide screen share where the browser cannot do it
const setVH = () => { document.documentElement.style.setProperty('--vh', (window.visualViewport ? visualViewport.height : innerHeight) * 0.01 + 'px'); };
setVH(); addEventListener('resize', setVH); if (window.visualViewport) visualViewport.addEventListener('resize', () => { setVH(); scrollTo(0, 0); });
if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) $('scr').classList.add('hide');
const playAll = () => document.querySelectorAll('#grid video').forEach((v) => v.paused && v.play().catch(() => {}));
document.addEventListener('click', playAll); document.addEventListener('touchend', playAll);
})();
