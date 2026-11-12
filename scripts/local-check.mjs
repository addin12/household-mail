// Runs the Worker code on this computer against real Google, using secrets/worker-secrets.json. Prints only masked addresses and counts.
//   node scripts/local-check.mjs
import { readFileSync } from 'node:fs';
import { route } from '../src/index.js';

const env = JSON.parse(readFileSync(new URL('../secrets/worker-secrets.json', import.meta.url), 'utf8'));
let n = 0;
const call = async (name, args) => {
  const res = await route(new Request('https://local/mcp', { method: 'POST', headers: { authorization: `Bearer ${env.MCP_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: (n += 1), method: 'tools/call', params: { name, arguments: args } }) }), env);
  const r = (await res.json()).result;
  return { error: r.isError ? r.content[0].text : '', data: r.isError ? null : JSON.parse(r.content[0].text) };
};
const mask = (a) => String(a).replace(/^(.{2}).*(@.*)$/, '$1***$2');
for (const who of ['addin', 'muthia1', 'muthia2']) {
  const w = await call(`gmail_${who}_whoami`, {});
  if (w.error) { console.log(`${who}: ERROR ${w.error}`); continue; }
  const s = await call(`gmail_${who}_search`, { query: 'newer_than:30d', max: 3 });
  const msgs = s.data ? s.data[0].messages : [];
  let readOk = '';
  if (msgs[0]) { const r = await call(`gmail_${who}_read`, { id: msgs[0].id }); readOk = r.error ? `read ERROR ${r.error}` : `read ok (${r.data[0].body.length} chars)`; }
  console.log(`${who}: ${mask(w.data.emailAddress)} | search ${s.error || `${msgs.length} mails`} | ${readOk}`);
}
