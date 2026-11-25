// Mine Party: pass the sea mine by naming valid answers before its hidden fuse runs out.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const packs = require('./packs');
const { matchDetail } = require('./match');
const { judge } = require('./judge');
const auth = require('./auth');

const rooms = new Map();
const DEFAULTS = { lives: 3, fuseMin: 10, fuseMax: 30, minPass: 8, pack: '' };
// Abuse caps: rooms are tiny but unbounded growth is still unbounded growth, and
// websockets cost memory per connection.
const MAX_ROOMS = 200;
const MAX_CONN_PER_IP = 10;
const MAX_MSGS_PER_WINDOW = 60, MSG_WINDOW_MS = 10e3;

function code() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(c));
  return c;
}

function attach(server, { cleanName, scoreGuess, currentPlayer, db, logRejected, sameSite }) {
  // small payload cap: legit messages are tiny JSON, anything bigger is junk.
  // verifyClient applies the same origin policy as POSTs, during the handshake —
  // cross-site pages can't ride a victim's session cookie onto the websocket.
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192, verifyClient: (info, cb) => {
    if (info.req.headers.origin && !sameSite(info.req)) return cb(false, 403, 'Bad origin');
    cb(true);
  } });

  const connsByIp = new Map(); // ip -> open connection count
  wss.on('connection', (ws, req) => {
    const ip = auth.clientIp(req);
    const conns = (connsByIp.get(ip) || 0) + 1;
    connsByIp.set(ip, conns);
    if (conns > MAX_CONN_PER_IP) {
      connsByIp.set(ip, conns - 1);
      return ws.close(1008, 'too many connections');
    }
    ws.req = req;
    ws.isAlive = true;
    ws.msgCount = 0;
    ws.msgWindowStart = Date.now();
    ws.on('pong', () => (ws.isAlive = true));
    // ws emits 'error' e.g. when maxPayload is exceeded; without a handler it crashes the process
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      // sliding-window message rate cap: floods get the connection closed
      const now = Date.now();
      if (now - ws.msgWindowStart > MSG_WINDOW_MS) { ws.msgWindowStart = now; ws.msgCount = 0; }
      if (++ws.msgCount > MAX_MSGS_PER_WINDOW) return ws.close(1008, 'message rate exceeded');
      let m; try { m = JSON.parse(raw); } catch { return; }
      Promise.resolve().then(() => handle(ws, m)).catch(e => console.error('[party]', e));
    });
    ws.on('close', () => {
      const n = (connsByIp.get(ip) || 1) - 1;
      if (n > 0) connsByIp.set(ip, n); else connsByIp.delete(ip);
      const room = rooms.get(ws.roomCode);
      const p = room?.players.find(p => p.id === ws.playerId);
      if (p && p.ws === ws) { p.connected = false; p.ws = null; onLeave(room, p); }
    });
  });

  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 20000).unref();

  function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function broadcast(room, msg) { for (const p of room.players) send(p.ws, msg); }

  function view(room) {
    return {
      code: room.code, phase: room.phase, hostId: room.hostId, settings: room.settings, round: room.round,
      players: room.players.map(p => ({ id: p.id, name: p.name, lives: p.lives, points: p.points, connected: p.connected })),
      holderId: room.holderId, prompt: room.prompt ? { text: room.prompt.text, hint: room.prompt.hint || null } : null,
      used: room.used, holdStart: room.holdStart, winnerId: room.winnerId, lastBoom: room.lastBoom,
      lastRejected: room.lastRejected ? { text: room.lastRejected.text, by: room.lastRejected.by } : null,
      packs: packs.listPacks(),
    };
  }
  function sync(room) { broadcast(room, { t: 'state', room: view(room) }); }

  function alive(room) { return room.players.filter(p => p.lives > 0); }
  function nextHolder(room, fromId) {
    const order = room.players;
    const start = order.findIndex(p => p.id === fromId);
    for (let k = 1; k <= order.length; k++) {
      const p = order[(start + k) % order.length];
      if (p.lives > 0 && p.connected) return p;
    }
    return order.find(p => p.lives > 0) || null;
  }

  function pickPrompt(room) {
    let pool = packs.randomPrompts(50, room.settings.pack || null);
    const fresh = pool.filter(p => !room.seenPrompts.has(p.id));
    if (fresh.length) pool = fresh; else room.seenPrompts.clear();
    const p = pool[0];
    room.seenPrompts.add(p.id);
    return p;
  }

  function startRound(room, holder) {
    const s = room.settings;
    room.round++;
    room.phase = 'playing';
    room.prompt = pickPrompt(room);
    room.used = [];
    room.usedKeys = new Set();
    room.lastRejected = null;
    room.holderId = (holder && holder.lives > 0 && holder.connected ? holder : nextHolder(room, holder?.id))?.id;
    room.holdStart = Date.now();
    room.fuseEnd = Date.now() + (s.fuseMin + Math.random() * (s.fuseMax - s.fuseMin)) * 1000;
    sync(room);
  }

  function boom(room) {
    const holder = room.players.find(p => p.id === room.holderId);
    if (holder) holder.lives--;
    room.phase = 'boom';
    room.lastBoom = { id: holder?.id, name: holder?.name, answers: sampleAnswers(room) };
    sync(room);
    const left = alive(room);
    const solo = room.players.length === 1;
    setTimeout(() => {
      if (!rooms.has(room.code)) return;
      if ((!solo && left.length <= 1) || left.length === 0) {
        room.phase = 'over';
        room.winnerId = left[0]?.id || [...room.players].sort((a, b) => b.points - a.points)[0]?.id;
        room.holderId = null;
        sync(room);
      } else {
        startRound(room, holder);
      }
    }, 4000);
  }

  function sampleAnswers(room) {
    const usedNames = new Set(room.used.map(u => u.name));
    const left = room.prompt.answers.filter(a => !usedNames.has(a.name));
    left.sort((a, b) => b.tier - a.tier);
    return [...new Set(left.slice(0, 2).concat(left.filter(a => a.tier <= 2).slice(0, 2)))].map(a => a.name);
  }

  function pass(room, holder, answerName, tier) {
    const t = packs.TIERS[tier];
    holder.points += t.points;
    room.used.push({ name: answerName, tierName: t.name, tier, by: holder.name });
    room.usedKeys.add(answerName);
    room.lastRejected = null;
    const remaining = room.fuseEnd - Date.now();
    room.fuseEnd = Date.now() + Math.max(remaining, room.settings.minPass * 1000);
    const next = nextHolder(room, holder.id);
    room.holderId = next.id;
    room.holdStart = Date.now();
    broadcast(room, { t: 'pass', from: holder.name, answer: answerName, tierName: t.name, tier });
    sync(room);
  }

  function onLeave(room, p) {
    if (room.players.every(x => !x.connected)) {
      setTimeout(() => { if (room.players.every(x => !x.connected)) rooms.delete(room.code); }, 10 * 60e3);
      return;
    }
    if (room.hostId === p.id) room.hostId = room.players.find(x => x.connected).id;
    if (room.phase === 'lobby') {
      room.players = room.players.filter(x => x.id !== p.id);
    } else if (room.phase === 'playing' && room.holderId === p.id) {
      const next = nextHolder(room, p.id);
      if (next && next.id !== p.id) { room.holderId = next.id; room.holdStart = Date.now(); }
    }
    sync(room);
  }

  async function handle(ws, m) {
    if (m.t === 'create' || m.t === 'join') {
      const player = await currentPlayer(ws.req);
      if (!player) return send(ws, { t: 'error', msg: 'Log in or pick a guest name first' });
      const name = cleanName(player.display_name);
      let room;
      if (m.t === 'create') {
        if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', msg: 'Too many games running right now, try again later' });
        if (auth.tooMany('room:' + player.id, 6, 3600e3)) return send(ws, { t: 'error', msg: 'You\'ve made a lot of rooms lately, try again later' });
        room = { code: code(), phase: 'lobby', players: [], hostId: null, settings: { ...DEFAULTS }, round: 0, seenPrompts: new Set(), used: [], usedKeys: new Set() };
        rooms.set(room.code, room);
      } else {
        room = rooms.get(String(m.code || '').toUpperCase());
        if (!room) return send(ws, { t: 'error', msg: 'No room with that code' });
      }
      // rejoin by account session, or reclaim a disconnected seat by name+token:
      // the token proves this browser held the seat even if the session behind it
      // was lost (cookie cleared, guest session expired) and the player re-authed
      let p = room.players.find(x => x.playerId === player.id);
      if (!p && typeof m.token === 'string' && m.token) {
        const seat = room.players.find(x => !x.connected && x.token === m.token && x.name.toLowerCase() === name.toLowerCase());
        if (seat) {
          p = seat;
          p.playerId = player.id; // rebind the seat to the player's current session
          p.token = crypto.randomUUID(); // rotate: the old token did its job, don't let it be reused
        }
      }
      if (!p) {
        if (room.phase !== 'lobby') return send(ws, { t: 'error', msg: 'Game in progress, wait for the next one' });
        if (room.players.some(x => x.name.toLowerCase() === name.toLowerCase())) return send(ws, { t: 'error', msg: 'Someone in the room already has that name' });
        if (room.players.some(x => x.playerId === player.id)) return send(ws, { t: 'error', msg: 'You\'re already in this room in another tab' });
        if (room.players.length >= 16) return send(ws, { t: 'error', msg: 'Room is full' });
        p = { id: crypto.randomUUID().slice(0, 8), playerId: player.id, token: crypto.randomUUID(), name, lives: room.settings.lives, points: 0 };
        room.players.push(p);
      }
      if (p.ws && p.ws !== ws && p.ws.readyState === 1) send(p.ws, { t: 'error', msg: 'You opened this room somewhere else' });
      p.ws = ws; p.connected = true;
      ws.roomCode = room.code; ws.playerId = p.id;
      if (!room.hostId || !room.players.find(x => x.id === room.hostId)?.connected) room.hostId = p.id;
      send(ws, { t: 'joined', code: room.code, you: p.id, token: p.token });
      return sync(room);
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const me = room.players.find(p => p.id === ws.playerId);
    if (!me) return;
    const isHost = room.hostId === me.id;

    switch (m.t) {
      case 'settings': {
        if (!isHost || room.phase !== 'lobby') return;
        const s = room.settings, n = m.settings || {};
        s.lives = clamp(n.lives ?? s.lives, 1, 9);
        s.fuseMin = clamp(n.fuseMin ?? s.fuseMin, 5, 120);
        s.fuseMax = clamp(n.fuseMax ?? s.fuseMax, s.fuseMin, 180);
        s.minPass = clamp(n.minPass ?? s.minPass, 2, 60);
        if (typeof n.pack === 'string') s.pack = packs.listPacks().some(p => p.id === n.pack) ? n.pack : '';
        return sync(room);
      }
      case 'start': {
        if (!isHost || (room.phase !== 'lobby' && room.phase !== 'over')) return;
        room.players = room.players.filter(p => p.connected);
        for (const p of room.players) { p.lives = room.settings.lives; p.points = 0; }
        room.round = 0; room.winnerId = null; room.lastBoom = null;
        const first = room.players[Math.floor(Math.random() * room.players.length)];
        return startRound(room, first);
      }
      case 'lobby': {
        if (!isHost || room.phase !== 'over') return;
        room.phase = 'lobby';
        return sync(room);
      }
      case 'typing': {
        if (room.phase !== 'playing' || room.holderId !== me.id) return;
        return broadcast(room, { t: 'typing', id: me.id, text: String(m.text || '').slice(0, 40) });
      }
      case 'guess': {
        if (room.phase !== 'playing' || room.holderId !== me.id) return;
        const text = String(m.text || '').slice(0, 80).trim();
        if (!text) return;
        let r = scoreGuess(room.prompt, text);
        if (!r.ok) {
          // the fuse keeps burning while the AI judge thinks
          const verdict = await judge(room.prompt, text, { playerId: me.playerId, source: 'party' });
          if (room.phase !== 'playing' || room.holderId !== me.id) return; // it went off mid-judgement
          if (verdict?.valid) {
            const listed = matchDetail(room.prompt.index, verdict.name);
            if (!listed) {
              packs.addAnswer(room.prompt.id, verdict.name, verdict.tier);
              db.addAddition(room.prompt.id, verdict.name, verdict.tier).catch(e => console.error(e.message));
            }
            r = scoreGuess(room.prompt, listed ? listed.answer.name : verdict.name);
          }
        }
        if (!r.ok) {
          room.lastRejected = { text, by: me.name, holderId: me.id };
          logRejected(room.prompt.id, text, me.playerId);
          broadcast(room, { t: 'reject', by: me.name, text, reason: 'not on the list' });
          return sync(room);
        }
        if (room.usedKeys.has(r.answer)) {
          return broadcast(room, { t: 'reject', by: me.name, text, reason: `${r.answer} already taken` });
        }
        return pass(room, me, r.answer, r.tier);
      }
      case 'accept': {
        // host overrules the list: counts the holder's last rejected guess and saves it for next time
        const lr = room.lastRejected;
        if (!isHost || room.phase !== 'playing' || !lr || lr.holderId !== room.holderId) return;
        const holder = room.players.find(p => p.id === lr.holderId);
        packs.addAnswer(room.prompt.id, lr.text, 3);
        db.addAddition(room.prompt.id, lr.text, 3).catch(e => console.error(e.message));
        return pass(room, holder, lr.text, 3);
      }
      case 'kick': {
        if (!isHost || room.phase !== 'lobby' || m.id === me.id) return;
        const k = room.players.find(p => p.id === m.id);
        if (k) { send(k.ws, { t: 'kicked' }); k.ws?.close(1000, 'kicked'); room.players = room.players.filter(p => p !== k); sync(room); }
        return;
      }
    }
  }

  // fuse loop
  setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.phase === 'playing' && now >= room.fuseEnd) boom(room);
    }
  }, 100).unref();
}

function clamp(v, lo, hi) { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo; }

module.exports = { attach };
