// Calls the DEPLOYED Worker like Claude Code would. Prints only masked addresses and counts.
//   node scripts/remote-check.mjs [url]
import { readFileSync } from 'node:fs';
import { workerUrl } from './worker-url.mjs';

const url = workerUrl(process.argv[2]);
const token = readFileSync(new URL('../secrets/mcp-token.txt', import.meta.url), 'utf8').trim();
let n = 0;
const rpc = async (method, params) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: (n += 1), method, ...(params ? { params } : {}) }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
const mask = (a) => String(a).replace(/^(.{2}).*(@.*)$/, '$1***$2');
const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
console.log('server:', init.result.serverInfo.name);
const tools = (await rpc('tools/list')).result.tools;
console.log('tools:', tools.length);
for (const who of ['addin', 'muthia1', 'muthia2']) {
  const t0 = Date.now();
  const w = (await rpc('tools/call', { name: `gmail_${who}_whoami`, arguments: {} })).result;
  if (w.isError) { console.log(`${who}: ERROR ${w.content[0].text}`); continue; }
  const s = (await rpc('tools/call', { name: `gmail_${who}_search`, arguments: { query: 'newer_than:30d', max: 5 } })).result;
  const msgs = s.isError ? [] : JSON.parse(s.content[0].text)[0].messages;
  console.log(`${who}: ${mask(JSON.parse(w.content[0].text).emailAddress)} | ${s.isError ? s.content[0].text : `${msgs.length} mails`} | ${Date.now() - t0} ms`);
}
