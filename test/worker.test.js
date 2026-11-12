// The Gmail reader, tested against a fake Gmail and a fake Google token endpoint (no network, no real mail).
import { beforeEach, describe, expect, it } from 'vitest';
import { route, authorized } from '../src/index.js';
import { forgetTokens, bodyOf } from '../src/gmail.js';
import { TOOLS } from '../src/mcp.js';

const SECRET = 'test-bearer-token-0123456789abcdef';
const ENV = { MCP_TOKEN: SECRET, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', REFRESH_ADDIN: 'r-addin', REFRESH_MUTHIA1: 'r-m1' };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

/** A fake Google: records every call and answers token, list, metadata, full and profile requests. */
function fakeGoogle({ tokenError } = {}) {
  const calls = [];
  const messages = {
    aaa111aa: { id: 'aaa111aa', threadId: 't1', internalDate: '1793000000000', snippet: 'Transaksi berhasil', payload: { headers: [{ name: 'From', value: 'BCA <bca@bca.co.id>' }, { name: 'Subject', value: 'Transaction Journal' }, { name: 'Date', value: 'Thu, 5 Nov 2026 10:00:00 +0700' }, { name: 'To', value: 'me@example.com' }], mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('Total Rp 25.000 — Bayar di Kopi') } }, { mimeType: 'text/html', body: { data: b64('<p>HTML <b>copy</b></p>') } }] } },
    bbb222bb: { id: 'bbb222bb', threadId: 't2', internalDate: '1793000100000', snippet: 's', payload: { headers: [{ name: 'From', value: 'x@y.id' }, { name: 'Subject', value: 'Html only' }], mimeType: 'text/html', body: { data: b64('<style>p{color:red}</style><div>Halo&nbsp;dunia &amp; semua</div><p>Baris dua</p>') } } },
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (u.startsWith('https://oauth2.googleapis.com/token')) return tokenError ? reply(400, { error: tokenError }) : reply(200, { access_token: `at-${new URLSearchParams(init.body).get('refresh_token')}`, expires_in: 3600 });
    if (!/^Bearer at-/.test(init.headers?.authorization || '')) return reply(401, {});
    if (u.includes('/profile')) return reply(200, { emailAddress: 'me@example.com' });
    if (/\/messages\?/.test(u)) return reply(200, { messages: [{ id: 'aaa111aa' }, { id: 'bbb222bb' }] });
    const id = /\/messages\/([^?]+)/.exec(u)?.[1];
    return messages[id] ? reply(200, messages[id]) : reply(404, {});
  };
  return { fetchImpl, calls };
}

const rpc = (body, headers = {}) => new Request('https://mail.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}`, ...headers }, body: JSON.stringify(body) });
const call = async (name, args, g = fakeGoogle(), env = ENV) => {
  const res = await route(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), env, { fetchImpl: g.fetchImpl });
  const out = await res.json();
  return { out, text: out.result?.content?.[0]?.text, g };
};

beforeEach(() => forgetTokens());

describe('who may call', () => {
  it('only POST /mcp with the right bearer token', async () => {
    const f = fakeGoogle().fetchImpl;
    expect((await route(rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: '' }), ENV, { fetchImpl: f })).status).toBe(401);
    expect((await route(rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: 'Bearer wrong-wrong-wrong-wrong-wrong' }), ENV, { fetchImpl: f })).status).toBe(401);
    expect((await route(rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: SECRET }), ENV, { fetchImpl: f })).status).toBe(401); // no "Bearer "
    expect((await route(rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }), ENV, { fetchImpl: f })).status).toBe(200);
    expect((await route(new Request('https://mail.example/mcp', { method: 'GET' }), ENV)).status).toBe(405);
    expect((await route(new Request('https://mail.example/other', { method: 'POST' }), ENV)).status).toBe(404);
  });
  it('a missing or short secret lets nobody in, even with a matching header', async () => {
    expect(await authorized('Bearer short', 'short')).toBe(false);
    expect(await authorized('Bearer x', '')).toBe(false);
    expect(await authorized(`Bearer ${SECRET}`, undefined)).toBe(false);
    expect(await authorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(await authorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
  });
  it('refuses a body that is not JSON, or too large, or a batch that is too long', async () => {
    const bad = new Request('https://mail.example/mcp', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: '{nope' });
    expect((await route(bad, ENV)).status).toBe(400);
    const big = new Request('https://mail.example/mcp', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ a: 'x'.repeat(100001) }) });
    expect((await route(big, ENV)).status).toBe(413);
    const batch = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }));
    expect((await route(rpc(batch), ENV)).status).toBe(400);
  });
});

describe('the MCP handshake', () => {
  it('initialize answers with the tool capability, a notification gets no body, an unknown method is an error', async () => {
    const init = await (await route(rpc({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-03-26' } }), ENV)).json();
    expect(init).toMatchObject({ id: 7, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'household-mail' } } });
    expect((await route(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), ENV)).status).toBe(202);
    const unknown = await (await route(rpc({ jsonrpc: '2.0', id: 2, method: 'nope' }), ENV)).json();
    expect(unknown.error.code).toBe(-32601);
    const invalid = await (await route(rpc({ id: 3 }), ENV)).json();
    expect(invalid.error.code).toBe(-32600);
  });
  it('lists search, read and whoami for each of the three accounts, under the old n8n names', async () => {
    const list = await (await route(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ENV)).json();
    const names = list.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['gmail_addin_search', 'gmail_addin_read', 'gmail_addin_whoami', 'gmail_muthia1_search', 'gmail_muthia2_read', 'gmail_muthia2_whoami']));
    expect(names).toHaveLength(15);
    expect(TOOLS.every((t) => t.inputSchema.type === 'object')).toBe(true);
  });
  it('a batch is answered message by message, notifications left out', async () => {
    const res = await route(rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]), ENV);
    expect((await res.json()).map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('search', () => {
  it('asks Gmail for the query and the number, then each mail\'s headers, and returns sender, subject, date and snippet', async () => {
    const { out, text, g } = await call('gmail_addin_search', { query: 'from:bca.co.id newer_than:7d', max: 2 });
    expect(out.result.isError).toBeUndefined();
    const data = JSON.parse(text);
    expect(data[0].messages).toEqual([
      { id: 'aaa111aa', threadId: 't1', from: 'BCA <bca@bca.co.id>', subject: 'Transaction Journal', date: new Date(1793000000000).toISOString(), snippet: 'Transaksi berhasil' },
      expect.objectContaining({ id: 'bbb222bb', subject: 'Html only' }),
    ]);
    const list = g.calls.find((c) => /\/messages\?/.test(c.url)).url;
    expect(new URL(list).searchParams.get('q')).toBe('from:bca.co.id newer_than:7d');
    expect(new URL(list).searchParams.get('maxResults')).toBe('2');
    expect(g.calls.filter((c) => c.url.includes('format=metadata'))).toHaveLength(2);
  });
  it('max defaults to 10, is at most 25 and at least 1', async () => {
    const asked = async (max) => new URL((await call('gmail_addin_search', { query: 'x', max })).g.calls.find((c) => /\/messages\?/.test(c.url)).url).searchParams.get('maxResults');
    expect(await asked(undefined)).toBe('10');
    expect(await asked(500)).toBe('25');
    expect(await asked(0)).toBe('10');
    expect(await asked('7')).toBe('7');
    expect(await asked(3.9)).toBe('3');
  });
  it('an empty or over-long query is refused before Gmail is asked', async () => {
    const empty = await call('gmail_addin_search', { query: '   ' });
    expect(empty.out.result).toMatchObject({ isError: true });
    expect(empty.text).toBe('query is required');
    expect(empty.g.calls).toHaveLength(0);
    const long = await call('gmail_addin_search', { query: 'x'.repeat(501) });
    expect(long.text).toContain('longer than 500');
    expect(long.g.calls).toHaveLength(0);
  });
});

describe('read', () => {
  it('returns the headers and the plain-text body (UTF-8 intact), not the HTML copy', async () => {
    const { text } = await call('gmail_addin_read', { id: 'aaa111aa' });
    expect(JSON.parse(text)[0]).toMatchObject({ id: 'aaa111aa', from: 'BCA <bca@bca.co.id>', to: 'me@example.com', subject: 'Transaction Journal', body: 'Total Rp 25.000 — Bayar di Kopi' });
  });
  it('a mail with only HTML gets its tags, style and entities taken out', async () => {
    const { text } = await call('gmail_addin_read', { id: 'bbb222bb' });
    expect(JSON.parse(text)[0].body).toBe('Halo dunia & semua\nBaris dua');
  });
  it('only a Gmail message id is accepted: nothing else reaches the URL', async () => {
    for (const id of ['../profile', 'abc?x=1', '', undefined, 'zz', 'a'.repeat(40)]) {
      const r = await call('gmail_addin_read', { id });
      expect(r.out.result.isError, String(id)).toBe(true);
      expect(r.g.calls, String(id)).toHaveLength(0);
    }
  });
  it('bodyOf prefers plain text, handles nested parts, and caps very long bodies', () => {
    const nested = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<b>h</b>') } }, { mimeType: 'text/plain', body: { data: b64('plain') } }] }] };
    expect(bodyOf(nested)).toBe('plain');
    expect(bodyOf({ mimeType: 'text/plain', body: { data: b64('x'.repeat(300000)) } })).toHaveLength(200000);
    expect(bodyOf(undefined)).toBe('');
    expect(bodyOf({ mimeType: 'text/plain', body: { data: b64('   ') }, parts: [{ mimeType: 'text/html', body: { data: b64('<i>only html</i>') } }] })).toBe('only html');
  });
});

describe('whoami, sign-ins and errors', () => {
  it('whoami returns the signed-in address', async () => {
    expect(JSON.parse((await call('gmail_muthia1_whoami', {})).text)).toEqual({ emailAddress: 'me@example.com' });
  });
  it('each account uses its own refresh token, and the access token is reused until it nearly expires', async () => {
    const g = fakeGoogle();
    await call('gmail_addin_whoami', {}, g);
    await call('gmail_addin_whoami', {}, g);
    await call('gmail_muthia1_whoami', {}, g);
    const tokenCalls = g.calls.filter((c) => c.url.includes('oauth2.googleapis.com'));
    expect(tokenCalls.map((c) => new URLSearchParams(c.init.body).get('refresh_token'))).toEqual(['r-addin', 'r-m1']);
    const form = new URLSearchParams(tokenCalls[0].init.body);
    expect([form.get('client_id'), form.get('client_secret'), form.get('grant_type')]).toEqual(['cid', 'csecret', 'refresh_token']);
    expect(g.calls.find((c) => c.url.includes('/profile')).init.headers.authorization).toBe('Bearer at-r-addin');
  });
  it('an account with no stored sign-in says so; an expired sign-in says to sign in again; secrets never appear in the message', async () => {
    const none = await call('gmail_muthia2_whoami', {});
    expect(none.text).toBe('muthia2 is not connected here (no sign-in stored)');
    const expired = await call('gmail_addin_whoami', {}, fakeGoogle({ tokenError: 'invalid_grant' }));
    expect(expired.text).toBe('addin: the sign-in expired or was revoked: sign in to Google again');
    for (const t of [none.text, expired.text]) { expect(t).not.toContain('r-addin'); expect(t).not.toContain('csecret'); }
  });
  it('a Gmail error is reported with its status, and the next call asks for a fresh token', async () => {
    const g = fakeGoogle();
    const real = g.fetchImpl;
    let fail = true;
    g.fetchImpl = async (u, i) => (fail && String(u).includes('/profile') ? { ok: false, status: 503, json: async () => ({}) } : real(u, i));
    const first = await call('gmail_addin_whoami', {}, g);
    expect(first.text).toBe('Gmail answered 503 for addin');
    fail = false;
    expect((await call('gmail_addin_whoami', {}, g)).out.result.isError).toBeUndefined();
    expect(g.calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(2);
  });
  it('an unknown tool or account is an error result, not a crash', async () => {
    expect((await call('gmail_nobody_search', { query: 'x' })).out.result.isError).toBe(true);
    expect((await call('drop_tables', {})).text).toBe('unknown tool drop_tables');
    expect((await call(undefined, undefined)).out.result.isError).toBe(true);
  });
});
