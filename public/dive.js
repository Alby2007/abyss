// The dive: countdown, answering (with retries and typo confirms), the sink, result cards,
// and the end-of-dive screen.
import { creatureSvg, TIER_COLOR } from './creatures.js';

const TIERS = [
  { id: 1, name: 'Surface', points: 10 }, { id: 2, name: 'Shallows', points: 25 }, { id: 3, name: 'Twilight', points: 50 },
  { id: 4, name: 'Midnight', points: 75 }, { id: 5, name: 'Abyss', points: 100 }, { id: 6, name: 'Leviathan', points: 120 },
];
const EMOJI = ['💨', '🫧', '🐟', '🪼', '🦑', '🐡', '🐉'];
const BANDS = [
  [0, 150, 'Surface skimmer', 'Plenty of ocean left below you.'],
  [151, 300, 'Shoal swimmer', 'Comfortable with the crowd.'],
  [301, 450, 'Twilight drifter', 'Past the light. Good dive.'],
  [451, 600, 'Midnight diver', 'Seriously deep. Most people turn back long before this.'],
  [601, 9999, 'Trench dweller', 'Absurd. Are you even human?'],
];
const MAX = 7 * 120;

export function mountDive(ctx) {
  const { app, api, esc, sfx, toast, scene, myName, go, store } = ctx;

  async function start(mode, pack = '') {
    const r = await api('/api/dive/start', { name: myName(), mode, pack });
    if (r.error) return toast(esc(r.error), 'bad');
    if (r.already) return results({ score: r.already.score, depth: r.already.score * 10, picks: r.already.picks, mode: 'daily', date: r.date }, true);
    history.pushState({}, '', '/');
    run(r);
  }

  function run(startRes) {
    const sid = startRes.sessionId, mode = startRes.mode;
    let score = 0, tiers = [], busy = false, timerRaf = null, deadline = 0, answering = false;
    ctx.onLeave(() => cancelAnimationFrame(timerRaf));
    document.body.classList.add('diving');
    ctx.onLeave(() => document.body.classList.remove('diving'));
    scene.setDepth(0, true); scene.setDiverX(.5, true); scene.setTag(''); scene.clearLines();
    scene.setFocus(.36, true); scene.showLabels(innerWidth >= 1100); document.body.classList.remove('home', 'sky');

    app.innerHTML = `
      <div class="dive">
        <div class="hud">
          <div class="hud-box"><span>depth</span><b id="hudDepth">0 m</b></div>
          <div class="hud-mid"><div class="pips" id="pips"></div><span id="hudStep"></span></div>
          <div class="hud-box right"><span>score</span><b id="hudScore">0</b></div>
        </div>
        <div class="stage" id="stage"></div>
        <div class="dock" id="dock" hidden>
          <div class="dock-msg" id="msg"></div>
          <form class="dock-row" id="form" autocomplete="off">
            <div class="ring" id="ring"><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" class="track"/><circle cx="22" cy="22" r="19" class="bar" id="ringBar"/></svg><span id="ringNum"></span></div>
            <input type="text" id="guess" maxlength="80" placeholder="Type one answer" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" enterkeyhint="go">
            <button class="btn primary" id="diveBtn" type="submit">Dive</button>
          </form>
          <button class="link-btn" id="giveUp" type="button">Skip this one</button>
        </div>
      </div>`;
    const $ = s => app.querySelector(s);
    const stage = $('#stage'), dock = $('#dock'), input = $('#guess'), msg = $('#msg');
    scene.onDepth(m => {
      $('#hudDepth') && ($('#hudDepth').textContent = `${Math.round(m).toLocaleString()} m`);
      $('#hudScore') && ($('#hudScore').textContent = Math.round(m / 10));
    });

    function pips(i, n) {
      $('#pips').innerHTML = Array.from({ length: n }, (_, k) => `<span class="pip ${k === i ? 'now' : ''}" ${k < tiers.length ? `data-t="${tiers[k]}"` : ''}></span>`).join('');
      $('#hudStep').textContent = i < n ? `prompt ${i + 1} of ${n}` : 'dive complete';
    }

    function showPrompt(p) {
      pips(p.i, p.total);
      scene.setDiverX(.16); scene.setTag(''); scene.clearLines();
      stage.innerHTML = `
        <div class="prompt-card rise">
          <span class="eyebrow">Prompt ${p.i + 1} of ${p.total}${mode === 'daily' ? '' : ', free dive'}</span>
          <h2 class="prompt">${esc(p.text)}</h2>
          <span class="sub">${p.hint ? esc(p.hint) : '▼ rarer answers sink deeper ▼'}</span>
        </div>`;
      dock.hidden = false; input.value = ''; input.disabled = true; $('#diveBtn').disabled = true;
      setRing(1, p.seconds);
      let n = p.countdown || 3;
      msg.className = 'dock-msg'; msg.textContent = `Descending. The clock starts in ${n}`;
      const tick = setInterval(() => {
        n--;
        if (n > 0) { msg.textContent = `Descending. The clock starts in ${n}`; sfx.tick(); return; }
        clearInterval(tick); msg.textContent = '';
        input.disabled = false; $('#diveBtn').disabled = false; input.focus();
        startClock(p.seconds);
      }, 1000);
      ctx.onLeave(() => clearInterval(tick));
    }

    function setRing(frac, secs) {
      const c = 2 * Math.PI * 19;
      $('#ringBar').style.strokeDasharray = c;
      $('#ringBar').style.strokeDashoffset = c * (1 - frac);
      $('#ringNum').textContent = Math.ceil(secs);
      $('#ring').classList.toggle('low', secs <= 5);
    }

    function startClock(seconds) {
      answering = true;
      const dur = seconds * 1000; deadline = performance.now() + dur;
      let lastSec = seconds;
      (function frame(now) {
        const left = Math.max(0, deadline - now);
        setRing(left / dur, left / 1000);
        const sec = Math.ceil(left / 1000);
        if (sec < lastSec && sec <= 5 && sec > 0) sfx.tick();
        lastSec = sec;
        if (left <= 0) { answering = false; return submit(input.value, true); }
        timerRaf = requestAnimationFrame(frame);
      })(performance.now());
    }

    $('#form').onsubmit = (e) => { e.preventDefault(); if (answering && input.value.trim()) submit(input.value, false); };
    $('#giveUp').onclick = () => { if (answering) { answering = false; submit('', true); } };

    async function submit(text, giveUp) {
      if (busy) return; busy = true;
      let r;
      try {
        r = await api('/api/dive/answer', { sessionId: sid, guess: text, giveUp });
      } catch {
        toast('Connection hiccup — your answer didn’t reach the server. Try again.', 'bad');
        return;
      } finally {
        busy = false; // never wedge the input, whatever happens above
      }
      if (r.error) { toast(esc(r.error), 'bad'); return go('/'); }
      if (r.retry) {
        sfx.bad();
        msg.className = 'dock-msg bad'; msg.innerHTML = `“${esc(r.guess)}” isn’t on the list. Try another.`;
        $('#form').classList.remove('shake'); void $('#form').offsetWidth; $('#form').classList.add('shake');
        input.select();
        return;
      }
      if (r.confirm) {
        msg.className = 'dock-msg warn';
        msg.innerHTML = `“${esc(r.confirm.from)}” → <b>“${esc(r.confirm.to)}”</b><br><small>dive again to confirm, or edit</small>`;
        input.value = r.confirm.to; input.focus();
        return;
      }
      answering = false;
      cancelAnimationFrame(timerRaf);
      dock.hidden = true; stage.innerHTML = '';
      await sink(r);
      card(r);
    }

    async function sink(r) {
      const res = r.result, from = scene.depth;
      scene.setDiverX(.5); scene.showLabels(true);
      scene.setLines(TIERS.map(t => ({ m: from + t.points * 10, label: `${t.name} ${t.points}`, color: TIER_COLOR[t.id] })));
      if (!res.ok) {
        scene.setTag(res.guess || 'no answer', TIER_COLOR[0]);
        scene.flash('#ff6b5e'); sfx.bad();
        await new Promise(r => setTimeout(r, 1100));
        return;
      }
      scene.setTag(res.answer, TIER_COLOR[res.tier]);
      await new Promise(r => setTimeout(r, 350));
      await scene.sink(from + res.points * 10, { onLine: () => sfx.tick() });
      scene.flash(TIER_COLOR[res.tier]);
      sfx.good(res.tier);
    }

    function card(r) {
      const res = r.result, rv = r.reveal, t = res.ok ? res.tier : 0;
      tiers.push(t); score += res.points;
      pips(tiers.length, startRes.prompt.total);
      scene.clearLines(); scene.setTag(''); scene.setDiverX(.14); scene.showLabels(innerWidth >= 1100);
      const tierName = res.ok ? res.tierName : (res.guess ? 'No echo' : 'Out of air');
      stage.innerHTML = `
        <div class="result-card rise">
          <div class="creature-wrap">${creatureSvg(t, t === 6 ? 7 : 7)}</div>
          <h3 class="tier-title tier-${t}">${esc(tierName)}</h3>
          <div class="result-answer">${res.ok ? `“${esc(res.answer)}”` : res.guess ? `“${esc(res.guess)}”` : '—'}</div>
          <div class="result-pts"><b class="tier-${t}">+${res.points} pts</b>, sinks you ${res.points * 10} m</div>
          <p class="flavour">${esc(res.flavour || '')}</p>
          ${res.fact ? `<p class="fact">${esc(res.fact)}</p>` : ''}
          ${mode === 'daily' && res.ok ? `<p class="muted small">${res.friendsSaid ? `${res.friendsSaid} other ${res.friendsSaid === 1 ? 'diver' : 'divers'} said this` : 'Nobody else in your group has said this yet'}</p>` : ''}
          <details class="peek"><summary>what else counted</summary>
            <div class="reveal">
              ${rv.gem ? `<div class="line"><span class="muted">Leviathan</span><b class="tier-6">${esc(rv.gem)}</b></div>` : ''}
              ${rv.examples.slice().reverse().map(e => `<div class="line"><span class="muted">${TIERS[e.tier - 1].name}</span><b class="tier-${e.tier}">${esc(e.name)}</b></div>`).join('')}
              <div class="line"><span class="muted">Valid answers</span><b class="num">${rv.totalAnswers}</b></div>
            </div>
          </details>
          <button class="btn descend" id="next">${r.final ? 'Surface ▲' : 'Descend ▼'}</button>
        </div>`;
      const btn = $('#next'); btn.focus();
      btn.onclick = async () => {
        btn.disabled = true;
        if (r.final) {
          stage.innerHTML = '';
          await scene.sink(0, { duration: 1600 });
          return results(r.final);
        }
        const n = await api('/api/dive/next', { sessionId: sid });
        if (n.error) return toast(esc(n.error), 'bad');
        showPrompt(n.prompt);
      };
    }

    showPrompt(startRes.prompt);
  }

  // ---------- end of dive ----------
  function shareText(f) {
    const line = f.picks.map(p => EMOJI[p.ok ? p.tier : 0]).join('');
    return `abyss. ${f.mode === 'daily' ? f.date : 'free dive'}\n${line}\n${f.score} pts, ${f.depth.toLocaleString()} m down\n${location.origin}`;
  }

  function band(score) { return BANDS.find(b => score >= b[0] && score <= b[1]) || BANDS[0]; }

  function curveSvg(scores, mine) {
    const W = 600, H = 150, bw = 45;
    const xs = Array.from({ length: 121 }, (_, i) => i * MAX / 120);
    const dens = xs.map(x => scores.reduce((s, v) => s + Math.exp(-((x - v) ** 2) / (2 * bw * bw)), 0));
    const top = Math.max(...dens) || 1;
    const px = x => 10 + (x / MAX) * (W - 20), py = d => H - 22 - (d / top) * (H - 40);
    const path = xs.map((x, i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)},${py(dens[i]).toFixed(1)}`).join('');
    const mx = px(Math.min(MAX, mine));
    const myD = dens[Math.round(Math.min(MAX, mine) / MAX * 120)];
    const ticks = [0, 140, 280, 420, 560, 700, 840].map(v => `<text x="${px(v)}" y="${H - 4}" text-anchor="middle">${v}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="curve" role="img" aria-label="How your score compares">
      <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7cf3ff" stop-opacity=".55"/><stop offset="1" stop-color="#7cf3ff" stop-opacity="0"/></linearGradient></defs>
      <path d="${path} L${px(MAX)},${H - 22} L${px(0)},${H - 22} Z" fill="url(#cg)"/>
      <path d="${path}" fill="none" stroke="#7cf3ff" stroke-width="2"/>
      <line x1="10" x2="${W - 10}" y1="${H - 22}" y2="${H - 22}" stroke="rgba(160,220,235,.25)"/>
      <line x1="${mx}" x2="${mx}" y1="${py(myD)}" y2="${H - 22}" stroke="#ffb547" stroke-width="2"/>
      <circle cx="${mx}" cy="${py(myD)}" r="5" fill="#ffb547"/>
      <text x="${mx}" y="${py(myD) - 12}" text-anchor="middle" class="you">YOU</text>
      ${ticks}
    </svg>`;
  }

  function logSvg(picks) {
    const W = 600, H = 220, n = picks.length;
    const px = i => 40 + i * ((W - 70) / Math.max(1, n - 1)), py = v => 24 + (v / 120) * (H - 60);
    const grid = [0, 25, 50, 75, 100, 120].map(v => `<line x1="30" x2="${W - 20}" y1="${py(v)}" y2="${py(v)}" stroke="rgba(160,220,235,.12)"/><text x="24" y="${py(v) + 3}" text-anchor="end">${v}</text>`).join('');
    const cols = picks.map((p, i) => {
      const t = p.ok ? p.tier : 0, c = TIER_COLOR[t], v = p.points;
      return `<line x1="${px(i)}" x2="${px(i)}" y1="${py(0)}" y2="${py(v)}" stroke="${c}" stroke-width="2" opacity=".6"/>
        <circle cx="${px(i)}" cy="${py(v)}" r="7" fill="${c}" style="filter:drop-shadow(0 0 6px ${c})"/>
        <text x="${px(i)}" y="${H - 10}" text-anchor="middle">${i + 1}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="divelog" role="img" aria-label="Dive log">${grid}${cols}</svg>`;
  }

  async function results(f, already = false) {
    document.body.classList.remove('diving'); document.body.classList.add('sky');
    ctx.onLeave(() => document.body.classList.remove('sky'));
    scene.setFocus(.1, true); scene.showLabels(false);
    scene.setDepth(0, true); scene.setDiverX(.82, true); scene.setTag(''); scene.clearLines();
    const name = myName();
    const [lb, me] = await Promise.all([
      f.mode === 'daily' ? api('/api/leaderboard?date=' + f.date) : Promise.resolve(null),
      name ? api('/api/me') : Promise.resolve(null),
    ]);
    const scores = lb ? lb.daily.map(r => r.score) : [];
    const others = scores.length - 1;
    const ties = scores.filter(s => s === f.score).length - 1; // everyone else on the same score counts half
    const beat = others > 0 ? Math.round((scores.filter(s => s < f.score).length + ties / 2) / others * 100) : null;
    const b = band(f.score);

    app.innerHTML = `
      <div class="stack end">
        <div class="row spread"><span class="small muted">${already ? 'You’ve already done today’s dive' : f.mode === 'daily' ? `Daily dive for ${new Date(f.date + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` : 'Free dive'}</span></div>
        <div class="end-score"><span class="big">${f.score}</span><span class="depth">${f.depth.toLocaleString()} m down</span></div>

        ${f.mode === 'daily' ? `<section class="panel">
          ${scores.length >= 2 ? curveSvg(scores, f.score) : ''}
          <p class="beat">${beat === null ? 'You’re the first to dive today. Send it round.' : `Deeper than ${beat}% of the ${scores.length} people who dived today.`}</p>
        </section>` : ''}

        <section class="panel">
          <div class="row spread"><h3>Your dive</h3><span class="small muted">Lower means rarer</span></div>
          ${logSvg(f.picks)}
        </section>

        <section class="panel bands">
          ${BANDS.map(x => `<div class="band ${x === b ? 'me' : ''}"><span class="num">${x[0]}${x[1] > 2000 ? '+' : '–' + x[1]}</span><b>${x[2]}</b><span class="muted">${x[3]}</span></div>`).join('')}
        </section>

        <div class="share-box">${esc(shareText(f))}</div>
        <div class="row">
          <button class="btn primary" id="copy">Copy result</button>
          <button class="btn" id="again">Keep diving ∞</button>
          <button class="btn" data-nav="/board">Leaderboard</button>
          <button class="btn" data-nav="home">Home</button>
        </div>

        ${me && !me.error ? `<section class="panel logbook">
          <div><b class="num">${me.streak}</b><span>day streak</span></div><div><b class="num">${me.played}</b><span>dives</span></div><div><b class="num">${me.avg}</b><span>average</span></div><div><b class="num">${me.best}</b><span>best</span></div>
          <span id="nextDive"></span>
        </section>` : ''}

        <section class="panel">
          <div class="row spread"><h3>Every answer</h3><span class="small muted">Open a prompt to see what else counted</span></div>
          <div class="catch">
            ${f.picks.map((p, i) => `
              <div class="round" data-i="${i}">
                <button class="round-head" data-pid="${esc(p.promptId)}">
                  <span class="num muted">${i + 1}</span>
                  <span class="q">${esc(p.prompt)}</span>
                  <span class="a ${p.ok ? 'tier-' + p.tier : 'tier-0'}">${p.ok ? esc(p.answer) : (p.guess ? esc(p.guess) + ' ✗' : 'no answer')}</span>
                  <b class="num tier-${p.ok ? p.tier : 0}">${p.points}</b>
                  <span class="chev">+</span>
                </button>
                <div class="round-body" hidden></div>
              </div>`).join('')}
          </div>
        </section>
      </div>`;
    const $ = s => app.querySelector(s);

    $('#copy').onclick = async () => {
      try { await navigator.clipboard.writeText(shareText(f)); toast('Copied. Go and make your friends feel shallow.', 'good'); }
      catch { toast('Couldn’t copy, select the text above instead', 'bad'); }
    };
    $('#again').onclick = () => start('unlimited');

    if (me?.nextDiveAt && $('#nextDive')) {
      const tick = () => {
        const s = Math.max(0, Math.floor((me.nextDiveAt - Date.now()) / 1000));
        $('#nextDive') && ($('#nextDive').textContent = `Next dive in ${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
      };
      tick(); const iv = setInterval(tick, 1000); ctx.onLeave(() => clearInterval(iv));
    }

    app.querySelectorAll('.round-head').forEach(h => h.onclick = () => openRound(h));
  }

  async function openRound(head) {
    const body = head.nextElementSibling;
    if (!body.hidden) { body.hidden = true; head.querySelector('.chev').textContent = '+'; return; }
    head.querySelector('.chev').textContent = '−';
    body.hidden = false;
    if (body.dataset.loaded) return;
    body.innerHTML = '<p class="muted small">Loading…</p>';
    const r = await api(`/api/answers?id=${encodeURIComponent(head.dataset.pid)}`);
    if (r.error) { body.innerHTML = `<p class="muted small">${esc(r.error)}</p>`; return; }
    body.dataset.loaded = '1';
    const counts = {}; for (const a of r.answers) counts[a.tier] = (counts[a.tier] || 0) + 1;
    let filter = 0, q = '';
    body.innerHTML = `
      <div class="chips">
        <button class="chip-btn on" data-t="0">All ${r.answers.length}</button>
        ${[6, 5, 4, 3, 2, 1].filter(t => counts[t]).map(t => `<button class="chip-btn tier-${t}" data-t="${t}">${TIERS[t - 1].name} ${counts[t]}</button>`).join('')}
      </div>
      <input type="text" class="search" placeholder="Search all answers…">
      <div class="answers"></div>`;
    const list = body.querySelector('.answers');
    const draw = () => {
      const rows = r.answers.filter(a => (!filter || a.tier === filter) && (!q || a.name.toLowerCase().includes(q)));
      list.innerHTML = rows.slice(0, 300).map(a => `
        <div class="ans">
          <span class="dot tier-${a.tier}">●</span>
          <span class="nm">${esc(a.name)}${a.tier === 6 && r.fact ? `<small class="muted">${esc(r.fact)}</small>` : ''}</span>
          <span class="small muted">${a.n ? `${a.n} said it` : ''}</span>
          <b class="num tier-${a.tier}">+${TIERS[a.tier - 1].points}</b>
        </div>`).join('') + (rows.length > 300 ? `<p class="muted small">+${rows.length - 300} more, search to narrow it down</p>` : '') || '<p class="muted small">Nothing matches.</p>';
    };
    body.querySelectorAll('.chip-btn').forEach(c => c.onclick = () => {
      filter = Number(c.dataset.t);
      body.querySelectorAll('.chip-btn').forEach(x => x.classList.toggle('on', x === c));
      draw();
    });
    body.querySelector('.search').oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
    draw();
  }

  return { start, results };
}
