// Real check of the sync tools against the deployed Worker. Prints counts and flags only, never mail content.
import { readFileSync } from 'node:fs';
import { workerUrl } from './worker-url.mjs';
const url = workerUrl();
const token = readFileSync(new URL('../secrets/mcp-token.txt', import.meta.url), 'utf8').trim();
let n = 0;
const tool = async (name, args) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: (n += 1), method: 'tools/call', params: { name, arguments: args } }) });
  const r = (await res.json()).result;
  return r.isError ? { error: r.content[0].text } : { data: JSON.parse(r.content[0].text) };
};
for (const who of ['addin', 'muthia1', 'muthia2']) {
  const l = await tool(`gmail_${who}_list`, { query: 'from:(bca@bca.co.id OR bankbri@bri.co.id OR no-reply@grab.com) after:1790000000', max: 30 });
  if (l.error) { console.log(`${who}: list ERROR ${l.error}`); continue; }
  let line = `${who}: ${l.data.length} ids`;
  if (l.data[0]) { const f = await tool(`gmail_${who}_fetch`, { id: l.data[0] }); line += f.error ? ` | fetch ERROR ${f.error}` : ` | fetch ok: isHtml=${f.data.isHtml}, body ${f.data.body.length} chars, epochMs ${f.data.epochMs > 0 ? 'set' : 'missing'}, from ${f.data.from ? 'set' : 'missing'}`; }
  console.log(line);
}
