// The ocean: a canvas "camera" that moves through real depth in metres.
// Everything else in the UI floats on top of this.

const WATER = [
  [0, [27, 122, 147]], [150, [15, 85, 113]], [500, [10, 53, 80]], [1000, [7, 31, 51]],
  [3000, [4, 17, 31]], [6000, [2, 8, 18]], [9000, [1, 3, 7]],
];
const ZONES = [
  [200, 'THE TWILIGHT ZONE'], [1000, 'THE MIDNIGHT ZONE'], [4000, 'THE ABYSSAL ZONE'], [6000, 'THE HADAL ZONE'],
];
// Real depths, our own wording.
const FACTS = [
  [40, 'recreational divers stop around here'],
  [130, 'most sunlight is gone by now'],
  [332, 'deepest scuba dive on record, 332 m'],
  [535, 'emperor penguins have been tracked this deep'],
  [700, 'water pressure: about 70 times the surface'],
  [1280, 'deepest dive logged by a leatherback turtle'],
  [1500, 'anglerfish hang their lures out down here'],
  [2000, 'sperm whales hunt giant squid in this dark'],
  [2992, 'Cuvier’s beaked whale record dive, 2,992 m'],
  [3700, 'the average depth of the whole ocean'],
  [3800, 'the Titanic lies on the seabed near here'],
  [4500, 'the water is just above freezing'],
  [5500, 'below this, most of the seafloor is unexplored'],
  [6500, 'trench country: only a few submersibles get here'],
  [8336, 'deepest fish ever filmed, a snailfish'],
  [8400, 'the floor: a perfect dive ends here'],
];
const FLOOR = 8400;

function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
function waterAt(m) {
  if (m <= 0) return WATER[0][1];
  for (let i = 1; i < WATER.length; i++) {
    if (m <= WATER[i][0]) {
      const [m0, c0] = WATER[i - 1], [m1, c1] = WATER[i];
      return mix(c0, c1, (m - m0) / (m1 - m0));
    }
  }
  return WATER[WATER.length - 1][1];
}
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const easeInOut = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export function createScene(canvas) {
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1, ppm = 1;
  let cam = 0;                 // metres at the "focus" line
  const diver = { m: 0, x: .5, xTarget: .5, tag: '', tagColor: '#e8ff6b', visible: true };
  let lines = [], flashColor = null, flashT = 0, anim = null, onDepth = null, lastT = 0;
  const chunks = new Map();
  let snow = [];

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ppm = H / 650;
    snow = Array.from({ length: Math.round(W / 8) }, () => ({ x: Math.random() * W, m: Math.random() * (H / ppm), r: Math.random() * 1.5 + .3, d: Math.random() * 6.28 }));
  }
  addEventListener('resize', resize); resize();

  const focusY = () => H * 0.36;
  const y = m => focusY() + (m - cam) * ppm;

  // scenery is generated per 250 m chunk so it's stable as you pass it
  function chunk(k) {
    if (chunks.has(k)) return chunks.get(k);
    const r = rng(k * 9973 + 5), base = k * 250, items = [];
    const n = 3 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const m = base + r() * 250, x = r();
      if (m < 0) continue;
      if (m < 900) items.push({ kind: 'fish', m, x, s: .6 + r() * .9, v: (r() - .5) * 18, ph: r() * 6 });
      else if (m < 4200 && r() < .6) items.push({ kind: 'jelly', m, x, s: .6 + r() * .8, ph: r() * 6, hue: r() < .5 ? [120, 210, 255] : [210, 140, 255] });
      if (m > 700) items.push({ kind: 'glow', m: base + r() * 250, x: r(), ph: r() * 6, c: r() < .5 ? [232, 255, 107] : [94, 230, 255] });
    }
    chunks.set(k, items);
    return items;
  }

  function drawSky(top) {
    if (top <= 0) return;
    const g = ctx.createLinearGradient(0, 0, 0, top);
    g.addColorStop(0, '#0b2233'); g.addColorStop(1, '#2b7189');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, top);
    // low moon
    const mx = W * .78, my = top - H * .16;
    const glow = ctx.createRadialGradient(mx, my, 0, mx, my, 90);
    glow.addColorStop(0, 'rgba(232,255,180,.55)'); glow.addColorStop(1, 'rgba(232,255,180,0)');
    ctx.fillStyle = glow; ctx.fillRect(mx - 90, my - 90, 180, 180);
    ctx.fillStyle = '#eaf7d0'; ctx.beginPath(); ctx.arc(mx, my, 16, 0, 6.29); ctx.fill();
  }

  function drawWater(top) {
    const m0 = Math.max(0, cam - focusY() / ppm), m1 = cam + (H - focusY()) / ppm;
    const g = ctx.createLinearGradient(0, Math.max(0, top), 0, H);
    const span = m1 - m0 || 1;
    g.addColorStop(0, rgb(waterAt(m0)));
    for (const [m, c] of WATER) if (m > m0 && m < m1) g.addColorStop((m - m0) / span, rgb(c));
    g.addColorStop(1, rgb(waterAt(m1)));
    ctx.fillStyle = g; ctx.fillRect(0, Math.max(0, top), W, H);
  }

  function drawSurface(top, t) {
    if (top < -20 || top > H + 20) return;
    // light rays
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      const x = (W / 6) * i + Math.sin(t / 2400 + i) * 30;
      const g = ctx.createLinearGradient(0, top, 0, top + H * .7);
      g.addColorStop(0, 'rgba(180,240,255,.10)'); g.addColorStop(1, 'rgba(180,240,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x + 50, top); ctx.lineTo(x + 140, top + H * .7); ctx.lineTo(x - 40, top + H * .7); ctx.fill();
    }
    ctx.restore();
    // waves
    ctx.fillStyle = 'rgba(200,245,255,.18)';
    ctx.beginPath(); ctx.moveTo(0, top);
    for (let x = 0; x <= W; x += 8) ctx.lineTo(x, top + Math.sin(x / 38 + t / 600) * 3);
    ctx.lineTo(W, top - 6); ctx.lineTo(0, top - 6); ctx.fill();
  }

  function drawScenery(t) {
    const k0 = Math.floor((cam - focusY() / ppm) / 250) - 1, k1 = Math.floor((cam + H / ppm) / 250) + 1;
    for (let k = Math.max(0, k0); k <= k1; k++) {
      for (const o of chunk(k)) {
        const yy = y(o.m);
        if (yy < -60 || yy > H + 60) continue;
        if (o.kind === 'fish') {
          const x = ((o.x * W + t / 1000 * o.v) % (W + 80) + W + 80) % (W + 80) - 40, s = o.s * 7, dir = o.v > 0 ? 1 : -1;
          ctx.fillStyle = 'rgba(4,20,32,.55)';
          ctx.beginPath(); ctx.ellipse(x, yy, s * 1.6, s * .6, 0, 0, 6.29); ctx.fill();
          ctx.beginPath(); ctx.moveTo(x - dir * s * 1.4, yy); ctx.lineTo(x - dir * s * 2.4, yy - s * .7); ctx.lineTo(x - dir * s * 2.4, yy + s * .7); ctx.fill();
        } else if (o.kind === 'jelly') {
          const x = o.x * W, b = Math.sin(t / 900 + o.ph) * 6, s = o.s * 14;
          ctx.save(); ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = rgb(o.hue, .16);
          ctx.beginPath(); ctx.ellipse(x, yy + b, s, s * .65, 0, Math.PI, 0); ctx.fill();
          ctx.strokeStyle = rgb(o.hue, .22); ctx.lineWidth = 1;
          for (let i = -2; i <= 2; i++) {
            ctx.beginPath(); ctx.moveTo(x + i * s * .35, yy + b);
            ctx.quadraticCurveTo(x + i * s * .35 + Math.sin(t / 500 + i) * 5, yy + b + s, x + i * s * .3, yy + b + s * 1.8); ctx.stroke();
          }
          ctx.restore();
        } else if (o.kind === 'glow') {
          const a = (Math.sin(t / 700 + o.ph) + 1) / 2;
          ctx.fillStyle = rgb(o.c, .15 + a * .5);
          ctx.beginPath(); ctx.arc(o.x * W, yy, 1.5 + a * 1.5, 0, 6.29); ctx.fill();
        }
      }
    }
    // rock walls in the deep
    if (cam > 3800) {
      const fade = Math.min(1, (cam - 3800) / 1500);
      for (const side of [0, 1]) {
        ctx.fillStyle = `rgba(1,4,9,${.85 * fade})`;
        ctx.beginPath();
        const x0 = side ? W : 0;
        ctx.moveTo(x0, 0);
        for (let py = 0; py <= H; py += 18) {
          const m = cam + (py - focusY()) / ppm;
          const r = rng(Math.floor(m / 6) * 31 + side * 7)();
          const width = W * (.05 + .07 * Math.min(1, (m - 3800) / 3000)) + r * 26;
          ctx.lineTo(side ? W - width : width, py);
        }
        ctx.lineTo(x0, H); ctx.fill();
      }
    }
    // the floor
    const fy = y(FLOOR + 30);
    if (fy < H) { ctx.fillStyle = '#010205'; ctx.fillRect(0, fy, W, H - fy); }
  }

  function drawSnow(t, speed) {
    ctx.fillStyle = 'rgba(207,239,255,.5)';
    const span = H / ppm;
    for (const f of snow) {
      let rel = ((f.m - cam) % span + span) % span; // world-anchored, wraps
      const yy = rel * ppm;
      const x = f.x + Math.sin(t / 3000 + f.d) * 6;
      const streak = Math.min(18, Math.abs(speed) * ppm * .03);
      ctx.globalAlpha = .25 + f.r / 4;
      if (streak > 1.5) ctx.fillRect(x, yy - streak, f.r, streak);
      else { ctx.beginPath(); ctx.arc(x, yy, f.r, 0, 6.29); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
  }

  function drawLabels() {
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    FACTS.forEach(([m, text], i) => {
      const yy = y(m); if (yy < -10 || yy > H + 10) return;
      ctx.fillStyle = 'rgba(160,210,225,.45)';
      ctx.strokeStyle = 'rgba(160,210,225,.25)';
      if (i % 2) { ctx.textAlign = 'right'; ctx.fillText(text + '  —', W - 64, yy); }
      else { ctx.textAlign = 'left'; ctx.fillText('—  ' + text, 24, yy); }
    });
    ctx.font = '600 12px "JetBrains Mono", monospace';
    ZONES.forEach(([m, name]) => {
      const yy = y(m); if (yy < -10 || yy > H + 10) return;
      ctx.fillStyle = 'rgba(232,255,107,.22)'; ctx.fillRect(0, yy, W, 1);
      ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(232,255,107,.55)'; ctx.fillText(name, 24, yy - 10);
    });
  }

  function drawLines() {
    ctx.font = '600 11px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';
    for (const l of lines) {
      const yy = y(l.m); if (yy < -10 || yy > H + 10) continue;
      const hit = l.hit;
      ctx.strokeStyle = l.color; ctx.globalAlpha = hit ? 1 : .55; ctx.lineWidth = hit ? 2 : 1;
      ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.moveTo(W * .08, yy); ctx.lineTo(W - 72, yy); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = l.color; ctx.textAlign = 'right'; ctx.fillText(l.label, W - 76, yy - 10);
      ctx.globalAlpha = 1;
    }
  }

  function drawDiver(t) {
    if (!diver.visible) return;
    const bob = Math.sin(t / 700) * 3;
    const x = W * diver.x, yy = y(diver.m) + bob;
    // cable back to the surface
    ctx.strokeStyle = 'rgba(200,235,245,.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, Math.max(-5, y(-40))); ctx.lineTo(x, yy - 16); ctx.stroke();
    // headlamp
    if (diver.m > 150) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(x, yy + 10, 4, x, yy + 90, 120);
      g.addColorStop(0, 'rgba(232,255,107,.22)'); g.addColorStop(1, 'rgba(232,255,107,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x - 6, yy + 8); ctx.lineTo(x - 70, yy + 170); ctx.lineTo(x + 70, yy + 170); ctx.lineTo(x + 6, yy + 8); ctx.fill();
      ctx.restore();
    }
    // the bathysphere
    ctx.fillStyle = '#1a3644'; ctx.strokeStyle = '#cfe9f1'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, yy, 15, 0, 6.29); ctx.fill(); ctx.stroke();
    for (let a = 0; a < 6.28; a += 1.05) { ctx.fillStyle = '#cfe9f1'; ctx.beginPath(); ctx.arc(x + Math.cos(a) * 12, yy + Math.sin(a) * 12, 1.2, 0, 6.29); ctx.fill(); }
    ctx.fillStyle = '#e8ff6b'; ctx.shadowColor = '#e8ff6b'; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(x, yy, 6, 0, 6.29); ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#cfe9f1'; ctx.fillRect(x - 3, yy - 20, 6, 5);
    // answer tag
    if (diver.tag) {
      ctx.font = '700 15px "JetBrains Mono", monospace';
      const text = `“${diver.tag}”`, w = ctx.measureText(text).width + 24;
      const tx = x + 30, ty = yy - 15;
      ctx.fillStyle = 'rgba(4,14,22,.88)'; ctx.strokeStyle = diver.tagColor; ctx.lineWidth = 1.5;
      roundRect(tx, ty, w, 30, 8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = diver.tagColor; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, tx + 12, ty + 15);
    }
  }

  function drawRuler() {
    const x = W - 40;
    ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(x - 6, 0, 46, H);
    ctx.strokeStyle = 'rgba(160,210,225,.35)'; ctx.fillStyle = 'rgba(160,210,225,.6)';
    ctx.font = '10px "JetBrains Mono", monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const top = cam - focusY() / ppm, bot = cam + (H - focusY()) / ppm;
    for (let m = Math.max(0, Math.floor(top / 25) * 25); m <= bot; m += 25) {
      const yy = y(m), big = m % 100 === 0;
      ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + (big ? 10 : 5), yy); ctx.stroke();
      if (big) ctx.fillText(m >= 1000 ? (m / 1000).toFixed(1) + 'k' : String(m), x + 13, yy);
    }
    const yy = y(diver.m);
    ctx.fillStyle = '#e8ff6b'; ctx.beginPath(); ctx.moveTo(x - 2, yy); ctx.lineTo(x - 9, yy - 5); ctx.lineTo(x - 9, yy + 5); ctx.fill();
  }

  function roundRect(x, yy, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, yy); ctx.arcTo(x + w, yy, x + w, yy + h, r); ctx.arcTo(x + w, yy + h, x, yy + h, r);
    ctx.arcTo(x, yy + h, x, yy, r); ctx.arcTo(x, yy, x + w, yy, r); ctx.closePath();
  }

  let lastCam = 0;
  function frame(t) {
    const dt = Math.min(64, t - (lastT || t)); lastT = t;
    if (anim) {
      const p = Math.min(1, (t - anim.t0) / anim.dur);
      diver.m = anim.from + (anim.to - anim.from) * easeInOut(p);
      for (const l of lines) if (!l.hit && diver.m >= l.m - .5 && anim.to >= l.m) { l.hit = true; anim.onLine?.(l); }
      onDepth?.(diver.m);
      if (p >= 1) { const done = anim.done; anim = null; done(); }
    }
    cam += (diver.m - cam) * Math.min(1, dt / 160);
    diver.x += (diver.xTarget - diver.x) * Math.min(1, dt / 220);
    const speed = (cam - lastCam) / (dt || 16) * 1000; lastCam = cam;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const top = y(0);
    drawSky(top);
    drawWater(top);
    drawSurface(top, t);
    drawScenery(t);
    drawSnow(t, speed);
    drawLabels();
    drawLines();
    drawDiver(t);
    drawRuler();
    if (flashColor && flashT > 0) {
      ctx.fillStyle = flashColor; ctx.globalAlpha = flashT * .35; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
      flashT = Math.max(0, flashT - dt / 600);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    get depth() { return diver.m; },
    setDepth(m, instant = false) { anim = null; diver.m = m; if (instant) cam = m; onDepth?.(m); },
    onDepth(fn) { onDepth = fn; },
    setLines(ls) { lines = ls.map(l => ({ ...l, hit: false })); },
    clearLines() { lines = []; },
    setDiverX(f, instant = false) { diver.xTarget = f; if (instant) diver.x = f; },
    setTag(text, color = '#e8ff6b') { diver.tag = text; diver.tagColor = color; },
    flash(color) { flashColor = color; flashT = 1; },
    // animate the diver from its current depth to `to`
    sink(to, { duration, onLine } = {}) {
      const from = diver.m, dist = Math.abs(to - from);
      const dur = reduce ? 300 : (duration ?? Math.min(4200, 900 + dist * 2.6));
      return new Promise(done => { anim = { from, to, t0: performance.now(), dur, onLine, done }; });
    },
  };
}

export const SCENE_FLOOR = FLOOR;
