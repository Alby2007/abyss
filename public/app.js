// abyss. client
import { createScene } from './scene.js';
import { mountDive } from './dive.js';
import { mountAccount } from './account.js';
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d = null) { try { return JSON.parse(localStorage.getItem('abyss.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('abyss.' + k, JSON.stringify(v)); } catch {} },
};
let META = null;
let cleanup = []; // functions to run when leaving a view
const EMOJI = ['💨', '🫧', '🐟', '🪼', '🦑', '🐡', '🐉'];

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return res.json();
}

// ---------- ambience: the ocean behind everything ----------
const scene = createScene(document.getElementById('ocean'));
// Park the bathysphere somewhere pleasant for non-dive pages
function ambient(m = 0, x = .82) { scene.setDiverX(x); scene.setTag(''); scene.clearLines(); scene.sink(m, { duration: 1400 }); }

// iOS Safari doesn't shrink the layout viewport for the keyboard, so fixed
// bottom UI (the dive dock) ends up underneath it. Track the visible gap in
// --kb and let CSS lift bottom-anchored elements above the keys.
const vv = window.visualViewport;
function updKb() {
  const kb = vv ? Math.max(0, innerHeight - vv.height - vv.offsetTop) : 0;
  document.documentElement.style.setProperty('--kb', Math.round(kb) + 'px');
}
if (vv) { vv.addEventListener('resize', updKb); vv.addEventListener('scroll', updKb); updKb(); }

// tiny synth so there are no audio files to ship
const sfx = (() => {
  let ctx = null, muted = store.get('muted', false);
  const btn = $('#muteBtn');
  btn.classList.toggle('off', muted);
  btn.onclick = () => { muted = !muted; store.set('muted', muted); btn.classList.toggle('off', muted); };
  function tone(freq, dur = .12, type = 'sine', vol = .15, slide = 0) {
    if (muted) return;
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), ctx.currentTime + dur);
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + dur);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + dur);
  }
  return {
    good(t) { const base = 300 + t * 70; tone(base, .15); setTimeout(() => tone(base * 1.5, .25), 90); },
    bad() { tone(160, .25, 'square', .06, -80); },
    tick() { tone(1200, .03, 'square', .03); },
    pass() { tone(520, .08, 'triangle', .12, 300); },
    boom() { tone(90, .9, 'sawtooth', .25, -60); tone(60, 1.2, 'square', .12, -30); },
  };
})();

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.innerHTML = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3200);
}

// ---------- routing ----------
function go(path, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  route();
}
addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-nav]');
  if (a) { e.preventDefault(); go(a.dataset.nav === 'home' ? '/' : a.dataset.nav); }
});

function route() {
  cleanup.forEach(f => f()); cleanup = [];
  const p = location.pathname;
  let m;
  if (p === '/board') return viewBoard();
  if ((m = p.match(/^\/crew\/([A-Za-z]{5})$/))) return viewCrew(m[1].toUpperCase());
  if ((m = p.match(/^\/room\/([A-Za-z]{4}|new)$/))) return viewRoom(m[1].toUpperCase());
  if (p === '/admin') return viewAdmin();
  return viewHome();
}

const account = mountAccount({ api, esc, toast });
function myName() { return account.me?.name || ''; }
const needPlayer = (reason) => account.require(reason);
const needAccount = (reason) => account.requireAccount(reason);

// ---------- home ----------
async function viewHome() {
  ambient(0);
  const name = myName();
  app.innerHTML = `
    <section class="hero">
      <h1>The obvious answer<br>is <em>shallow.</em></h1>
      <p>Seven prompts. Twenty-five seconds each. Name something nobody else would think of and sink deeper.</p>
    </section>
    <div class="stack">
      <div class="modes">
        <button class="mode big" id="daily">
          <span class="tag" id="dailyTag">daily dive · ${META ? META.today : ''}</span>
          <h3>Today's dive</h3>
          <p>Same seven prompts for everyone. One go. Compare depths on the board.</p>
        </button>
        <button class="mode" id="unlimited">
          <span class="tag">practice</span>
          <h3>Free dive</h3>
          <p>Random prompts, as many runs as you like. Doesn't count for the board.</p>
        </button>
        <div class="mode" id="partyCard" style="cursor:default">
          <span class="tag">2 to 16 players</span>
          <h3>Mine Party</h3>
          <p>Hold the mine, name a valid answer to pass it on. Hidden fuse. Don't be holding it when it goes.</p>
          <div class="row" style="margin-top:8px">
            <button class="btn primary" id="create">Create room</button>
            <input type="text" id="code" maxlength="4" placeholder="CODE" style="width:110px;text-transform:uppercase;font-family:var(--mono)">
            <button class="btn" id="join">Join</button>
          </div>
        </div>
        <div class="mode" id="crewCard" style="cursor:default">
          <span class="tag">private boards</span>
          <h3>Crews</h3>
          <p>Start a private leaderboard and invite your friends with a code. Accounts only.</p>
          <div class="row" style="margin-top:8px">
            <input type="text" id="crewName" maxlength="20" placeholder="Crew name" autocomplete="off" autocorrect="off" style="flex:1;min-width:0">
            <button class="btn primary" id="crewCreate">Create crew</button>
          </div>
          <div class="row">
            <input type="text" id="crewCode" maxlength="5" placeholder="CODE" autocomplete="off" autocorrect="off" autocapitalize="characters" style="width:110px;text-transform:uppercase;font-family:var(--mono)">
            <button class="btn" id="crewJoin">Join crew</button>
          </div>
          <div class="crew-list" id="crewList"></div>
        </div>
        <button class="mode" data-nav="/board">
          <span class="tag">everyone</span>
          <h3>Leaderboard</h3>
          <p>Today's depths and the all-time table.</p>
        </button>
      </div>
      <div class="panel small muted" id="unlimitedOpts" hidden>
        <div class="row">
          <label class="field" style="flex:1">Pack
            <select id="pack"><option value="">Everything</option></select>
          </label>
          <button class="btn primary" id="goFree" style="align-self:end">Dive</button>
        </div>
      </div>
      <div class="legend muted" id="legend"></div>
    </div>`;
  $('#daily').onclick = async () => { if (await needPlayer('Pick a name or log in to start today\u2019s dive.')) dive.start('daily'); };
  $('#unlimited').onclick = () => { $('#unlimitedOpts').hidden = !$('#unlimitedOpts').hidden; };
  $('#goFree').onclick = async () => { if (await needPlayer()) dive.start('unlimited', $('#pack').value); };
  $('#create').onclick = async () => { if (await needPlayer()) go('/room/new'); };
  const join = async () => { const c = $('#code').value.trim().toUpperCase(); if (c.length !== 4) return toast('Room codes are 4 letters', 'bad'); if (await needPlayer()) go('/room/' + c); };
  $('#join').onclick = join;
  $('#code').onkeydown = (e) => { if (e.key === 'Enter') join(); };

  const drawCrews = async () => {
    if (!account.me || account.me.guest) { $('#crewList').innerHTML = ''; return; }
    const r = await api('/api/crews').catch(() => ({}));
    $('#crewList').innerHTML = (r.crews || []).map(c => `<button class="crew-chip" data-nav="/crew/${c.code}"><b>${esc(c.name)}</b><span class="mono muted">${c.code} · ${c.members}</span></button>`).join('');
  };
  $('#crewCreate').onclick = async () => {
    if (!(await needAccount('Log in or create an account to start a crew.'))) return;
    const r = await api('/api/crews', { name: $('#crewName').value });
    if (r.error) return toast(esc(r.error), 'bad');
    go('/crew/' + r.crew.code);
  };
  const joinCrew = async () => {
    const c = $('#crewCode').value.trim().toUpperCase();
    if (c.length !== 5) return toast('Crew codes are 5 letters', 'bad');
    if (await needAccount('Log in or create an account to join a crew.')) go('/crew/' + c);
  };
  $('#crewJoin').onclick = joinCrew;
  $('#crewCode').onkeydown = (e) => { if (e.key === 'Enter') joinCrew(); };
  drawCrews();

  META ||= await api('/api/meta');
  $('#dailyTag').textContent = `daily dive · ${META.today}`;
  $('#pack').innerHTML += META.packs.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${p.count})</option>`).join('');
  $('#legend').innerHTML = META.tiers.map(t => `<span class="tier-${t.id}">${t.name} ${t.points}</span>`).join('');
  if (name) {
    const lb = await api('/api/leaderboard');
    const mine = lb.daily.find(r => r.me);
    if (mine) {
      $('#daily').classList.add('done');
      $('#dailyTag').textContent = `done today · ${(mine.score * 10).toLocaleString()} m`;
    }
  }
}

// ---------- leaderboard ----------
async function viewBoard() {
  ambient(260);
  META ||= await api('/api/meta');
  let date = META.today, tab = 'daily';
  const me = myName().toLowerCase();
  async function draw() {
    const lb = await api('/api/leaderboard?date=' + date);
    const rows = tab === 'daily'
      ? lb.daily.map((r, i) => `<tr class="${r.me ? 'me' : ''}"><td class="num">${i + 1}</td><td>${esc(r.name)}${r.guest ? ' <span class="muted small">guest</span>' : ''}</td><td>${r.picks.map(t => EMOJI[t]).join('')}</td><td class="num">${(r.score * 10).toLocaleString()} m</td></tr>`).join('')
      : lb.allTime.map((r, i) => `<tr class="${r.name.toLowerCase() === me ? 'me' : ''}"><td class="num">${i + 1}</td><td>${esc(r.name)}${r.guest ? ' <span class="muted small">guest</span>' : ''}</td><td class="num">${r.dives}</td><td class="num">${(r.best * 10).toLocaleString()} m</td><td class="num">${(r.total * 10).toLocaleString()} m</td></tr>`).join('');
    app.innerHTML = `
      <div class="stack">
        <div class="row spread">
          <h2 style="font-size:34px">Leaderboard</h2>
          <div class="tabs"><button data-tab="daily" class="${tab === 'daily' ? 'on' : ''}">Daily</button><button data-tab="all" class="${tab === 'all' ? 'on' : ''}">All time</button></div>
        </div>
        ${tab === 'daily' ? `<div class="row"><button class="btn small" id="prev">←</button><span class="mono">${date}</span><button class="btn small" id="nextDay" ${date >= META.today ? 'disabled' : ''}>→</button></div>` : ''}
        <div class="panel">
          <table class="board">
            <thead>${tab === 'daily' ? '<tr><th></th><th>Diver</th><th>Dive</th><th style="text-align:right">Depth</th></tr>' : '<tr><th></th><th>Diver</th><th style="text-align:right">Dives</th><th style="text-align:right">Best</th><th style="text-align:right">Total</th></tr>'}</thead>
            <tbody>${rows || `<tr><td colspan="5" class="muted">Nobody has dived ${tab === 'daily' ? 'on this day' : 'yet'}.</td></tr>`}</tbody>
          </table>
        </div>
        <div class="row"><button class="btn" data-nav="home">Home</button></div>
      </div>`;
    app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; draw(); });
    const shift = (d) => { const t = new Date(date + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); date = t.toISOString().slice(0, 10); draw(); };
    $('#prev') && ($('#prev').onclick = () => shift(-1));
    $('#nextDay') && ($('#nextDay').onclick = () => shift(1));
  }
  draw();
}

// ---------- crews: private leaderboards ----------
async function viewCrew(code) {
  ambient(260);
  META ||= await api('/api/meta');
  if (!(await needAccount('Log in or create an account to open this crew.'))) {
    app.innerHTML = `<div class="panel stack"><h2>Crew ${esc(code)}</h2><p class="muted">Crews are for accounts only.</p><div class="row"><button class="btn primary" id="again">Log in</button><button class="btn" data-nav="home">Home</button></div></div>`;
    $('#again').onclick = () => route();
    return;
  }
  let date = META.today, tab = 'daily';
  async function draw() {
    const lb = await api(`/api/crews/board?code=${code}&date=${date}`);
    if (lb.notMember) {
      app.innerHTML = `<div class="panel stack"><h2>${esc(lb.name)}</h2><p class="muted">You’ve been invited to this private crew.</p><div class="row"><button class="btn primary" id="joinIt">Join crew</button><button class="btn" data-nav="home">Not now</button></div></div>`;
      $('#joinIt').onclick = async () => {
        const r = await api('/api/crews/join', { code });
        if (r.error) return toast(esc(r.error), 'bad');
        toast(`Joined ${esc(r.crew.name)}`, 'good'); draw();
      };
      return;
    }
    if (lb.error) {
      app.innerHTML = `<div class="panel stack"><h2>Crew ${esc(code)}</h2><p class="muted">${esc(lb.error)}</p><button class="btn" data-nav="home">Home</button></div>`;
      return;
    }
    const tag = (r) => r.guest ? ' <span class="muted small">guest</span>' : '';
    const rows = tab === 'daily'
      ? lb.daily.map((r, i) => `<tr class="${r.me ? 'me' : ''}"><td class="num">${i + 1}</td><td>${esc(r.name)}${tag(r)}</td><td>${r.picks.map(t => EMOJI[t]).join('')}</td><td class="num">${(r.score * 10).toLocaleString()} m</td></tr>`).join('')
      : lb.allTime.map((r, i) => `<tr class="${r.me ? 'me' : ''}"><td class="num">${i + 1}</td><td>${esc(r.name)}${tag(r)}</td><td class="num">${r.dives}</td><td class="num">${(r.best * 10).toLocaleString()} m</td><td class="num">${(r.total * 10).toLocaleString()} m</td></tr>`).join('');
    const link = `${location.origin}/crew/${lb.crew.code}`;
    app.innerHTML = `
      <div class="stack">
        <div class="row spread">
          <div><span class="tag crew-tag">private crew · ${lb.crew.members} diver${lb.crew.members === 1 ? '' : 's'}</span><h2 style="font-size:34px">${esc(lb.crew.name)}</h2></div>
          <div class="tabs"><button data-tab="daily" class="${tab === 'daily' ? 'on' : ''}">Daily</button><button data-tab="all" class="${tab === 'all' ? 'on' : ''}">All time</button></div>
        </div>
        <div class="panel crew-invite">
          <span class="muted small">Invite code</span>
          <div class="crew-code">${esc(lb.crew.code)}</div>
          <div class="row"><button class="btn small" id="copyCode">Copy code</button><button class="btn small" id="copyLink">Copy invite link</button></div>
        </div>
        ${tab === 'daily' ? `<div class="row"><button class="btn small" id="prev">←</button><span class="mono">${date}</span><button class="btn small" id="nextDay" ${date >= META.today ? 'disabled' : ''}>→</button></div>` : ''}
        <div class="panel">
          <table class="board">
            <thead>${tab === 'daily' ? '<tr><th></th><th>Diver</th><th>Dive</th><th style="text-align:right">Depth</th></tr>' : '<tr><th></th><th>Diver</th><th style="text-align:right">Dives</th><th style="text-align:right">Best</th><th style="text-align:right">Total</th></tr>'}</thead>
            <tbody>${rows || `<tr><td colspan="5" class="muted">Nobody in the crew has dived on this day.</td></tr>`}</tbody>
          </table>
        </div>
        <div class="row"><button class="btn" data-nav="home">Home</button><button class="btn small" id="leave">${lb.crew.mine ? 'Close crew' : 'Leave crew'}</button></div>
      </div>`;
    const copy = async (t, msg) => { try { await navigator.clipboard.writeText(t); toast(msg, 'good'); } catch { toast(esc(t)); } };
    $('#copyCode').onclick = () => copy(lb.crew.code, 'Code copied');
    $('#copyLink').onclick = () => copy(link, 'Invite link copied');
    $('#leave').onclick = async () => {
      if (!confirm(lb.crew.mine ? 'Close this crew for everyone?' : 'Leave this crew?')) return;
      await api('/api/crews/leave', { code }); go('/');
    };
    app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; draw(); });
    const shift = (d) => { const t = new Date(date + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); date = t.toISOString().slice(0, 10); draw(); };
    $('#prev') && ($('#prev').onclick = () => shift(-1));
    $('#nextDay') && ($('#nextDay').onclick = () => shift(1));
  }
  draw();
}

// ---------- mine party ----------
function mineSvg() {
  return `<svg class="mine" viewBox="0 0 100 100" aria-hidden="true">
    <g stroke="#e8ff6b" stroke-width="6" stroke-linecap="round">
      <path d="M50 8v14M50 78v14M8 50h14M78 50h14M20 20l10 10M70 70l10 10M80 20L70 30M30 70L20 80"/>
    </g>
    <circle cx="50" cy="50" r="27" fill="#e8ff6b"/>
    <circle cx="42" cy="43" r="6" fill="#04121c" opacity=".85"/>
    <circle cx="40" cy="41" r="2" fill="#fff"/>
  </svg>`;
}

function viewRoom(code) {
  ambient(140);
  if (!myName()) {
    app.innerHTML = `<div class="panel stack"><h2>Joining room ${esc(code === 'NEW' ? '' : code)}</h2><p class="muted">Pick a name or log in first.</p><button class="btn primary" id="ok">Pick a name</button></div>`;
    const ask = async () => { if (await needPlayer('Pick a name or log in to join the room.')) route(); };
    $('#ok').onclick = ask; ask();
    return;
  }
  app.innerHTML = `<p class="muted">Connecting…</p>`;
  let ws, you = null, room = null, key = '', closedByUs = false, retry = 0, beatTimer = null;
  const tokens = store.get('tokens', {});

  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => {
      retry = 0;
      if (code === 'NEW') ws.send(JSON.stringify({ t: 'create', name: myName() }));
      else ws.send(JSON.stringify({ t: 'join', code, name: myName(), token: tokens[code] }));
    };
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    ws.onclose = () => {
      if (closedByUs) return;
      if (retry++ < 8) { toast('Connection dropped, reconnecting…', 'bad'); setTimeout(connect, 600 * retry); }
      else app.innerHTML = `<div class="panel stack"><h2>Lost the connection</h2><button class="btn" data-nav="home">Home</button></div>`;
    };
  }
  const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
  cleanup.push(() => { closedByUs = true; ws?.close(); clearInterval(beatTimer); });
  connect();

  function onMsg(m) {
    switch (m.t) {
      case 'error':
        closedByUs = true; ws.close();
        app.innerHTML = `<div class="panel stack"><h2>${esc(m.msg)}</h2><button class="btn" data-nav="home">Home</button></div>`;
        return;
      case 'kicked':
        closedByUs = true;
        app.innerHTML = `<div class="panel stack"><h2>The host removed you from the room</h2><button class="btn" data-nav="home">Home</button></div>`;
        return;
      case 'joined':
        you = m.you; tokens[m.code] = m.token; store.set('tokens', tokens);
        if (code !== m.code) { code = m.code; history.replaceState({}, '', '/room/' + m.code); }
        return;
      case 'state': room = m.room; return draw();
      case 'typing': { const el = $('#typing'); if (el && m.id !== you) el.textContent = m.text || ''; return; }
      case 'pass':
        sfx.pass();
        toast(`<b>${esc(m.from)}</b> passed with <b class="tier-${m.tier}">${esc(m.answer)}</b> · ${esc(m.tierName)}`, 'good');
        return;
      case 'reject': {
        sfx.bad();
        toast(`<b>${esc(m.by)}</b>: “${esc(m.text)}” ${esc(m.reason)}`, 'bad');
        const box = $('#play'); box?.classList.remove('shake'); void box?.offsetWidth; box?.classList.add('shake');
        return;
      }
    }
  }

  function playersHtml() {
    const isHost = room.hostId === you;
    return room.players.map(p => `
      <div class="player ${p.id === room.holderId ? 'holder' : ''} ${room.phase !== 'lobby' && p.lives <= 0 ? 'out' : ''} ${p.connected ? '' : 'off'}">
        ${p.id === room.hostId ? '<span class="crown">host</span>' : ''}
        <span class="pname">${esc(p.name)}${p.id === you ? ' (you)' : ''}</span>
        ${room.phase === 'lobby' ? '' : `<span class="lives">${'♥'.repeat(Math.max(0, p.lives))}${'<span style="opacity:.25">' + '♥'.repeat(Math.max(0, room.settings.lives - p.lives)) + '</span>'}</span>
        <span class="ppts">${p.points} pts</span>`}
        ${isHost && room.phase === 'lobby' && p.id !== you ? `<button class="kick" data-kick="${p.id}" title="Remove">✕</button>` : ''}
      </div>`).join('');
  }

  function bindPlayers() {
    app.querySelectorAll('[data-kick]').forEach(b => b.onclick = () => send({ t: 'kick', id: b.dataset.kick }));
  }

  function draw() {
    const phaseKey = `${room.phase}:${room.round}`;
    const isHost = room.hostId === you;
    if (room.phase === 'boom') return drawBoom();
    $('.boom')?.remove();
    if (phaseKey === key && room.phase === 'playing') return patchPlaying();
    key = phaseKey;
    clearInterval(beatTimer);

    if (room.phase === 'lobby') {
      const s = room.settings;
      app.innerHTML = `
        <div class="stack">
          <div class="row spread">
            <div><span class="muted small mono">room code</span><div class="room-code">${room.code}</div></div>
            <button class="btn" id="copyLink">Copy invite link</button>
          </div>
          <div class="players" id="players">${playersHtml()}</div>
          <div class="panel stack">
            <h3>Settings ${isHost ? '' : '<span class="muted small">(host only)</span>'}</h3>
            <div class="settings">
              <label class="field">Lives<input type="number" id="s-lives" min="1" max="9" value="${s.lives}" ${isHost ? '' : 'disabled'}></label>
              <label class="field">Fuse min (s)<input type="number" id="s-fuseMin" min="5" max="120" value="${s.fuseMin}" ${isHost ? '' : 'disabled'}></label>
              <label class="field">Fuse max (s)<input type="number" id="s-fuseMax" min="5" max="180" value="${s.fuseMax}" ${isHost ? '' : 'disabled'}></label>
              <label class="field">Min after pass (s)<input type="number" id="s-minPass" min="2" max="60" value="${s.minPass}" ${isHost ? '' : 'disabled'}></label>
            </div>
            <label class="field">Pack
              <select id="s-pack" ${isHost ? '' : 'disabled'}><option value="">Everything</option>${room.packs.map(p => `<option value="${esc(p.id)}" ${p.id === s.pack ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
            </label>
            <p class="muted small" style="margin:0">The fuse is hidden and random between min and max. Passing keeps the remaining time, but never leaves the next diver less than the "min after pass". Rarer answers score more points, which break ties at the end.</p>
          </div>
          <div class="row">
            ${isHost ? `<button class="btn primary" id="start">${room.players.length < 2 ? 'Start solo (practice)' : 'Start the party'}</button>` : '<span class="muted">Waiting for the host to start…</span>'}
            <button class="btn" data-nav="home">Leave</button>
          </div>
        </div>`;
      bindPlayers();
      $('#copyLink').onclick = async () => {
        try { await navigator.clipboard.writeText(`${location.origin}/room/${room.code}`); toast('Invite link copied', 'good'); } catch { toast(`${location.origin}/room/${room.code}`); }
      };
      if (isHost) {
        for (const k of ['lives', 'fuseMin', 'fuseMax', 'minPass']) $('#s-' + k).onchange = (e) => send({ t: 'settings', settings: { [k]: Number(e.target.value) } });
        $('#s-pack').onchange = (e) => send({ t: 'settings', settings: { pack: e.target.value } });
        $('#start').onclick = () => send({ t: 'start' });
      }
      return;
    }

    if (room.phase === 'playing') {
      app.innerHTML = `
        <div class="stack" id="play">
          <div class="dive-head"><span>round ${room.round}</span><span>room ${room.code}</span></div>
          <h2 class="prompt" style="margin-top:4px">${esc(room.prompt.text)}</h2>
          ${room.prompt.hint ? `<p class="hint" style="margin:0">${esc(room.prompt.hint)}</p>` : ''}
          <div class="mine-wrap">${mineSvg()}</div>
          <div class="holder-line" id="holderLine"></div>
          <div class="live-typing" id="typing"></div>
          <form class="answer-row" id="pform" autocomplete="off">
            <input type="text" id="pguess" maxlength="80" placeholder="Name one to pass it on" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" enterkeyhint="send">
            <button class="btn primary" type="submit">Pass</button>
          </form>
          <div id="accept"></div>
          <div class="players" id="players"></div>
          <div><div class="muted small mono" style="margin-bottom:8px">taken this round</div><div class="used" id="used"></div></div>
        </div>`;
      const input = $('#pguess');
      let lastSent = 0, pending = null;
      input.oninput = () => {
        clearTimeout(pending);
        const sendNow = () => { lastSent = Date.now(); send({ t: 'typing', text: input.value }); };
        Date.now() - lastSent > 120 ? sendNow() : (pending = setTimeout(sendNow, 120));
      };
      $('#pform').onsubmit = (e) => {
        e.preventDefault();
        const v = input.value.trim(); if (!v) return;
        send({ t: 'guess', text: v }); input.value = ''; send({ t: 'typing', text: '' });
      };
      beatTimer = setInterval(() => {
        const held = (Date.now() - room.holdStart) / 1000;
        const mine = $('.mine'); if (mine) mine.style.setProperty('--beat', Math.max(.22, 1.1 - held * .06) + 's');
      }, 250);
      return patchPlaying(true);
    }

    if (room.phase === 'over') {
      const ranked = [...room.players].sort((a, b) => (b.lives - a.lives) || (b.points - a.points));
      const winner = room.players.find(p => p.id === room.winnerId);
      app.innerHTML = `
        <div class="stack">
          <span class="muted mono small">game over · ${room.round} rounds</span>
          <h2 style="font-size:clamp(40px,9vw,64px)">${winner ? `${esc(winner.name)} <span style="color:var(--lume)">survives.</span>` : 'Nobody survived.'}</h2>
          <div class="panel"><table class="board"><thead><tr><th></th><th>Diver</th><th style="text-align:right">Lives</th><th style="text-align:right">Points</th></tr></thead>
            <tbody>${ranked.map((p, i) => `<tr class="${p.id === you ? 'me' : ''}"><td class="num">${i + 1}</td><td>${esc(p.name)}</td><td class="num">${p.lives}</td><td class="num">${p.points}</td></tr>`).join('')}</tbody></table></div>
          <div class="row">
            ${isHost ? '<button class="btn primary" id="again">Play again</button><button class="btn" id="lobby">Change settings</button>' : '<span class="muted">Waiting for the host…</span>'}
            <button class="btn" data-nav="home">Leave</button>
          </div>
        </div>`;
      if (isHost) { $('#again').onclick = () => send({ t: 'start' }); $('#lobby').onclick = () => send({ t: 'lobby' }); }
    }
  }

  function patchPlaying(first = false) {
    const mineTurn = room.holderId === you;
    const holder = room.players.find(p => p.id === room.holderId);
    const isHost = room.hostId === you;
    $('#players').innerHTML = playersHtml();
    $('#holderLine').innerHTML = mineTurn ? '<b>You</b> are holding the mine. Name one!' : `<b>${esc(holder?.name || '…')}</b> is holding the mine`;
    const input = $('#pguess'), wasDisabled = input.disabled;
    input.disabled = !mineTurn;
    $('#pform button').disabled = !mineTurn;
    input.placeholder = mineTurn ? 'Name one to pass it on' : 'Wait for the mine…';
    if (mineTurn && (wasDisabled || first)) input.focus();
    if (!mineTurn) input.value = '';
    $('#typing').textContent = '';
    $('#used').innerHTML = room.used.length
      ? room.used.map(u => `<span class="chip tier-${u.tier}">${esc(u.name)} <span>${esc(u.by)}</span></span>`).join('')
      : '<span class="muted small">Nothing yet</span>';
    $('#accept').innerHTML = isHost && room.lastRejected
      ? `<button class="btn small" id="acceptBtn">Host: allow “${esc(room.lastRejected.text)}” and add it to the list</button>` : '';
    $('#acceptBtn') && ($('#acceptBtn').onclick = () => send({ t: 'accept' }));
  }

  function drawBoom() {
    if ($('.boom')) return;
    sfx.boom();
    const b = room.lastBoom || {};
    const el = document.createElement('div');
    el.className = 'boom';
    el.innerHTML = `<div class="inner"><h2>BOOM</h2>
      <p style="font-size:22px">${b.id === you ? 'It went off in <b>your</b> hands.' : `<b>${esc(b.name)}</b> was holding it.`}</p>
      ${b.answers?.length ? `<p class="muted">Still available: ${b.answers.map(esc).join(', ')}</p>` : ''}</div>`;
    document.body.append(el);
    key = '';
  }
}

// ---------- admin: review answers people tried that weren't accepted ----------
async function viewAdmin() {
  ambient(400);
  const k = store.get('adminKey', '') || prompt('Admin key (ADMIN_KEY env var on the server)') || '';
  store.set('adminKey', k);
  const r = await api('/api/admin/rejected?key=' + encodeURIComponent(k));
  if (r.error) { store.set('adminKey', ''); app.innerHTML = `<div class="panel">${esc(r.error)}</div>`; return; }
  app.innerHTML = `<div class="stack"><h2>Rejected guesses</h2><p class="muted">Accept the ones that should have counted. They're saved to data/additions.json.</p>
    <div class="panel"><table class="board"><thead><tr><th>Prompt</th><th>Guess</th><th>×</th><th></th></tr></thead><tbody>
    ${r.rejected.slice(0, 300).map((x, i) => `<tr><td class="small">${esc(x.promptId)}</td><td>${esc(x.guess)}</td><td class="num">${x.n}</td>
      <td><select data-i="${i}" class="tierSel" style="width:auto;padding:4px"><option value="1">Surface</option><option value="2">Shallows</option><option value="3" selected>Twilight</option><option value="4">Midnight</option><option value="5">Abyss</option></select>
      <button class="btn small" data-acc="${i}">Accept</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing yet</td></tr>'}
    </tbody></table></div></div>`;
  app.querySelectorAll('[data-acc]').forEach(b => b.onclick = async () => {
    const x = r.rejected[b.dataset.acc];
    const tier = app.querySelector(`.tierSel[data-i="${b.dataset.acc}"]`).value;
    const out = await api('/api/admin/accept', { key: k, promptId: x.promptId, name: x.guess, tier });
    if (out.ok) { b.closest('tr').style.opacity = .35; b.disabled = true; toast('Added', 'good'); } else toast(esc(out.error), 'bad');
  });
}

const dive = mountDive({ app, api, esc, sfx, toast, scene, myName, go, store, onLeave: f => cleanup.push(f) });
api('/api/meta').then(m => { META = m; });
// re-render the current page when someone logs in or out (but not mid-dive)
let ready = false;
account.onChange(() => { if (ready && !document.body.classList.contains('diving')) route(); });
account.init().then(me => {
  ready = true;
  route();
  // first visit: say hello with the pop-up
  if (!me && !location.pathname.startsWith('/room/')) account.open('guest');
});
