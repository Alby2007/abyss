import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');

const dir = process.env.HOME + '/AppData/Roaming/devin/mcp/oauth';
let cred = null;
for (const f of fs.readdirSync(dir)) {
  const j = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'));
  if (j.url?.includes('project_ref=wamopjfyyeozvylfluso')) { cred = j; break; }
}
if (!cred) { console.log('no full-access credential found'); process.exit(1); }
console.log('found full-access credential, expired:', cred.expires_at * 1000 < Date.now());

// discover the token endpoint
for (const wellknown of ['https://mcp.supabase.com/.well-known/oauth-authorization-server', 'https://api.supabase.com/.well-known/oauth-authorization-server']) {
  const r = await fetch(wellknown).catch(() => null);
  if (r?.ok) {
    const meta = await r.json();
    console.log('token endpoint:', meta.token_endpoint);
    if (!meta.token_endpoint) continue;
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cred.refresh_token, client_id: cred.client_id });
    const tr = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const data = await tr.json();
    if (data.access_token) {
      console.log('REFRESHED OK — scopes:', data.scope || '(none reported)');
      fs.writeFileSync('refreshed-token.tmp.json', JSON.stringify({ ...cred, access_token: data.access_token, refresh_token: data.refresh_token || cred.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600) }));
    } else {
      console.log('refresh failed:', JSON.stringify(data).slice(0, 300));
    }
    break;
  }
}
