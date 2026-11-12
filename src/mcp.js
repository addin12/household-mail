// MCP over HTTP (JSON-RPC), stateless: tools/list and tools/call for each Gmail account. Tool names match the old n8n server.
import { search, read, whoami, listIds, fetchMessage } from './gmail.js';

export const ACCOUNTS = ['addin', 'muthia1', 'muthia2'];
const ID = /^[0-9a-f]{8,32}$/i; // a Gmail message id
const MAX_QUERY = 500;

export const TOOLS = ACCOUNTS.flatMap((who) => [
  {
    name: `gmail_${who}_search`,
    description: `Search the Gmail of "${who}" (Gmail search syntax, e.g. from:bca.co.id newer_than:7d). Read-only. Returns sender, subject, date and a snippet.`,
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Gmail search query' }, max: { type: 'integer', minimum: 1, maximum: 25, description: 'how many mails (default 10, at most 25)' } }, required: ['query'] },
  },
  {
    name: `gmail_${who}_read`,
    description: `Read one mail of "${who}" by its id (from a search): headers and text body. Read-only.`,
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'message id' } }, required: ['id'] },
  },
  {
    name: `gmail_${who}_list`,
    description: `Message ids of "${who}" matching a Gmail query (newest first, up to 500). For the Cashflow sync. Read-only.`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['query'] },
  },
  {
    name: `gmail_${who}_fetch`,
    description: `One message of "${who}" as the Cashflow parsers take it: id, from, subject, epochMs, body (HTML when there is any) and isHtml. Read-only.`,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: `gmail_${who}_whoami`,
    description: `The e-mail address that "${who}" is signed in as.`,
    inputSchema: { type: 'object', properties: {} },
  },
]);

const clamp = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 25) : 10;
};

/** Runs one tool. Throws an Error with a plain message the caller can show. */
export async function callTool(env, name, args, opts) {
  const m = /^gmail_([a-z0-9]+)_(search|read|whoami|list|fetch)$/.exec(String(name));
  if (!m || !ACCOUNTS.includes(m[1])) throw new Error(`unknown tool ${String(name).slice(0, 60)}`);
  const [, who, kind] = m;
  const a = args && typeof args === 'object' ? args : {};
  if (kind === 'whoami') return whoami(env, who, opts);
  if (kind === 'fetch') {
    if (!ID.test(String(a.id || ''))) throw new Error('id must be a Gmail message id (from a search)');
    return fetchMessage(env, who, String(a.id), opts);
  }
  if (kind === 'list') {
    const query = String(a.query ?? '');
    if (!query.trim() || query.length > MAX_QUERY) throw new Error('query is required and at most 500 characters');
    const n = Math.trunc(Number(a.max));
    return listIds(env, who, query, Number.isFinite(n) && n >= 1 ? Math.min(n, 500) : 100, opts);
  }
  if (kind === 'read') {
    if (!ID.test(String(a.id || ''))) throw new Error('id must be a Gmail message id (from a search)');
    return read(env, who, String(a.id), opts);
  }
  const query = String(a.query ?? '');
  if (!query.trim()) throw new Error('query is required');
  if (query.length > MAX_QUERY) throw new Error(`query is longer than ${MAX_QUERY} characters`);
  return search(env, who, query, clamp(a.max), opts);
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** One JSON-RPC message in, one response out (null for a notification, which has no id). */
export async function handleRpc(env, msg, opts) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg && msg.id !== undefined ? msg.id : null, -32600, 'invalid request');
  const isNote = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'household-mail', version: '0.1.0' } });
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: TOOLS });
    case 'tools/call': {
      const p = msg.params || {};
      try {
        const data = await callTool(env, p.name, p.arguments, opts);
        return ok(msg.id, { content: [{ type: 'text', text: JSON.stringify(data) }] });
      } catch (e) {
        return ok(msg.id, { isError: true, content: [{ type: 'text', text: String(e.message || e).slice(0, 300) }] });
      }
    }
    default:
      return isNote ? null : fail(msg.id, -32601, `method not found: ${String(msg.method).slice(0, 60)}`);
  }
}
