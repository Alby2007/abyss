// Who's diving: guest names, username/password accounts, the pop-up and the header chip.
export function mountAccount({ api, esc, toast }) {
  let me = null;
  const listeners = [];
  const chip = document.getElementById('account');

  function set(p) { me = p; drawChip(); listeners.forEach(f => f(me)); }

  function drawChip() {
    if (!me) {
      chip.innerHTML = `<button class="acct-btn" id="acctOpen">Log in</button>`;
      chip.querySelector('#acctOpen').onclick = () => open('login');
      return;
    }
    chip.innerHTML = `
      <button class="acct-btn" id="acctMenuBtn" aria-haspopup="true">
        <span class="acct-dot ${me.guest ? 'guest' : ''}"></span>${esc(me.name)}${me.guest ? ' <span class="muted">(guest)</span>' : ''}
      </button>
      <div class="acct-menu" id="acctMenu" hidden>
        ${me.guest
          ? `<p class="small muted">Guest stats only live on this device. Make an account to keep them, they carry over.</p>
             <button class="btn primary block" data-act="register">Create account</button>
             <button class="btn block" data-act="login">Log in instead</button>
             <button class="btn block" data-act="switch">Use a different guest name</button>`
          : `<p class="small muted">Logged in as <b>${esc(me.username)}</b></p>
             <button class="btn block" data-act="logout">Log out</button>`}
      </div>`;
    const menu = chip.querySelector('#acctMenu');
    chip.querySelector('#acctMenuBtn').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    menu.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      menu.hidden = true;
      const act = b.dataset.act;
      if (act === 'logout' || act === 'switch') {
        await api('/api/auth/logout', {});
        set(null);
        open(act === 'switch' ? 'guest' : 'login');
      } else open(act);
    });
  }
  document.addEventListener('click', (e) => { const m = document.getElementById('acctMenu'); if (m && !chip.contains(e.target)) m.hidden = true; });

  // ----- the pop-up -----
  let pending = null; // resolve fn for whoever is waiting on a login
  function open(tab = 'guest', reason = '') {
    close(false);
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <div class="modal panel" role="dialog" aria-modal="true" aria-labelledby="authTitle">
        <button class="modal-x" aria-label="Close">✕</button>
        <h2 id="authTitle">Who’s diving?</h2>
        ${reason ? `<p class="muted small" style="margin:6px 0 0">${esc(reason)}</p>` : ''}
        <div class="tabs auth-tabs">
          <button data-tab="guest">Play as guest</button>
          <button data-tab="login">Log in</button>
          <button data-tab="register">${me?.guest ? 'Save my stats' : 'Create account'}</button>
        </div>
        <form class="stack" data-form="guest" autocomplete="off">
          <label class="field">Pick a name for today
            <input type="text" name="name" maxlength="20" placeholder="e.g. Deep Dave" autocomplete="nickname" required>
          </label>
          <p class="muted small" style="margin:0">One-time name, no password. Your scores stick to this browser until you log out or clear it.</p>
          <button class="btn primary block" type="submit">Start diving</button>
        </form>
        <form class="stack" data-form="login">
          <label class="field">Username<input type="text" name="username" maxlength="20" autocomplete="username" autocapitalize="off" required></label>
          <label class="field">Password<input type="password" name="password" autocomplete="current-password" required></label>
          <button class="btn primary block" type="submit">Log in</button>
        </form>
        <form class="stack" data-form="register">
          <label class="field">Username <span class="muted">(3–20 letters, numbers or _)</span>
            <input type="text" name="username" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" autocomplete="username" autocapitalize="off" required></label>
          <label class="field">Password <span class="muted">(6+ characters)</span>
            <input type="password" name="password" minlength="6" autocomplete="new-password" required></label>
          <label class="field">Password again<input type="password" name="password2" minlength="6" autocomplete="new-password" required></label>
          ${me?.guest ? `<p class="muted small" style="margin:0">Your guest dives as <b>${esc(me.name)}</b> move into the new account.</p>` : '<p class="muted small" style="margin:0">No email needed. Just don’t forget your password, there’s no reset yet.</p>'}
          <button class="btn primary block" type="submit">Create account</button>
        </form>
        <p class="form-err" role="alert"></p>
      </div>`;
    document.body.append(wrap);
    const err = wrap.querySelector('.form-err');
    const show = (t) => {
      wrap.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
      wrap.querySelectorAll('[data-form]').forEach(f => f.hidden = f.dataset.form !== t);
      err.textContent = '';
      wrap.querySelector(`[data-form="${t}"] input`).focus();
    };
    wrap.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => show(b.dataset.tab));
    wrap.querySelector('.modal-x').onclick = () => close(true);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(true); });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(true); });

    wrap.querySelectorAll('[data-form]').forEach(f => f.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      if (f.dataset.form === 'register' && d.password !== d.password2) { err.textContent = 'Those passwords don’t match'; return; }
      const btn = f.querySelector('button[type=submit]'); btn.disabled = true; err.textContent = '';
      const path = { guest: '/api/auth/guest', login: '/api/auth/login', register: '/api/auth/register' }[f.dataset.form];
      const r = await api(path, d).catch(() => ({ error: 'Couldn’t reach the server' }));
      btn.disabled = false;
      if (r.error) { err.textContent = r.error; f.querySelector('input').select?.(); return; }
      set(r.player);
      toast(f.dataset.form === 'guest' ? `Diving as ${esc(r.player.name)}` : f.dataset.form === 'login' ? `Welcome back, ${esc(r.player.name)}` : `Account made. Welcome, ${esc(r.player.name)}`, 'good');
      close(false, true);
    });
    show(tab);
  }

  function close(cancelled, ok = false) {
    document.querySelector('.modal-wrap')?.remove();
    if (pending) { const p = pending; pending = null; p(ok && !!me); }
  }

  // Resolves true once someone is logged in (or playing as a guest), false if they close the pop-up.
  function require(reason) {
    if (me) return Promise.resolve(true);
    return new Promise(res => { open('guest', reason); pending = res; });
  }

  // Like require, but guests don't count: resolves true only for a real account.
  async function requireAccount(reason) {
    if (me && !me.guest) return true;
    await new Promise(res => { open(me ? 'register' : 'login', reason); pending = res; });
    return !!me && !me.guest;
  }

  async function init() {
    const r = await api('/api/auth/me').catch(() => ({}));
    set(r.player || null);
    return me;
  }

  return { init, open, require, requireAccount, get me() { return me; }, onChange(f) { listeners.push(f); } };
}
