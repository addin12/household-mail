// household-mail: a read-only Gmail reader for Claude (MCP over HTTP). Only POST /mcp, only with the bearer token.
import { handleRpc } from './mcp.js';

const enc = new TextEncoder();

/** Compares the Authorization header with the secret without leaking where they differ (both are hashed first, so length does not leak either). */
export async function authorized(header, secret) {
  if (!secret || secret.length < 20) return false; // a missing or weak secret never lets anyone in
  const m = /^Bearer (.+)$/.exec(String(header || ''));
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(m ? m[1] : '')), crypto.subtle.digest('SHA-256', enc.encode(secret))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = m ? 0 : 1;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export async function route(request, env, opts) {
  const url = new URL(request.url);
  if (url.pathname !== '/mcp') return json({ error: 'not found' }, 404);
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
  if (!(await authorized(request.headers.get('authorization'), env.MCP_TOKEN))) return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
  const text = await request.text();
  if (text.length > 100000) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request too large' } }, 413);
  let msg;
  try { msg = JSON.parse(text); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400); }
  if (Array.isArray(msg)) {
    if (msg.length > 20) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch too large' } }, 400);
    const out = (await Promise.all(msg.map((m) => handleRpc(env, m, opts)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const res = await handleRpc(env, msg, opts);
  return res ? json(res) : new Response(null, { status: 202 });
}

export default { fetch: (request, env) => route(request, env) };
