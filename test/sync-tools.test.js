// The two tools the Cashflow sync uses: list message ids, fetch one message as the parsers take it.
import { beforeEach, describe, expect, it } from 'vitest';
import { route } from '../src/index.js';
import { findBody, forgetTokens } from '../src/gmail.js';
import { TOOLS } from '../src/mcp.js';

const SECRET = 'test-bearer-token-0123456789abcdef';
const ENV = { MCP_TOKEN: SECRET, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', REFRESH_ADDIN: 'r-addin' };
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const utf8 = (s) => b64(Buffer.from(s, 'utf8'));

/** A fake Google with `total` message ids, served 100 a page, and a few full messages. */
function fakeGoogle(total = 250) {
  const calls = [];
  const ids = Array.from({ length: total }, (_, i) => (i + 0x1000).toString(16).padStart(10, '0'));
  const full = {
    [ids[0]]: { id: ids[0], threadId: 't', internalDate: '1793000000000', payload: { headers: [{ name: 'From', value: 'BCA <bca@bca.co.id>' }, { name: 'Subject', value: 'Transaction Journal' }], mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: utf8('plain version') } }, { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }], body: { data: utf8('<p>html version Rp 25.000</p>') } }] } },
    [ids[1]]: { id: ids[1], threadId: 't', internalDate: '1793000100000', payload: { headers: [{ name: 'From', value: 'x@y.id' }, { name: 'Subject', value: 'Old encoding' }], mimeType: 'text/plain', headers2: [], body: { data: b64(Buffer.from([0x63, 0x61, 0x66, 0xe9])) } } },
  };
  full[ids[1]].payload.headers.push({ name: 'Content-Type', value: 'text/plain; charset=windows-1252' });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (u.startsWith('https://oauth2.googleapis.com/token')) return reply(200, { access_token: 'at-x', expires_in: 3600 });
    if (/\/messages\?/.test(u)) {
      const p = new URL(u).searchParams;
      const start = Number(p.get('pageToken') || 0);
      const size = Number(p.get('maxResults'));
      const slice = ids.slice(start, start + size);
      return reply(200, { messages: slice.map((id) => ({ id })), ...(start + size < ids.length ? { nextPageToken: String(start + size) } : {}) });
    }
    const id = /\/messages\/([^?]+)/.exec(u)?.[1];
    return full[id] ? reply(200, full[id]) : reply(404, {});
  };
  return { fetchImpl, calls, ids };
}

const call = async (name, args, g = fakeGoogle()) => {
  const res = await route(new Request('https://mail.example/mcp', { method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), ENV, { fetchImpl: g.fetchImpl });
  const out = await res.json();
  return { out, text: out.result?.content?.[0]?.text, g };
};
beforeEach(() => forgetTokens());

describe('tool list', () => {
  it('now has search, read, whoami, list and fetch for each of the three accounts', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['gmail_addin_list', 'gmail_muthia1_fetch', 'gmail_muthia2_list']));
    expect(TOOLS).toHaveLength(15);
  });
});

describe('list', () => {
  it('follows the pages and stops at max', async () => {
    const { text, g } = await call('gmail_addin_list', { query: 'from:bca.co.id after:1', max: 230 });
    const ids = JSON.parse(text);
    expect(ids).toHaveLength(230);
    expect(ids[0]).toBe(g.ids[0]);
    expect(g.calls.filter((c) => /\/messages\?/.test(c))).toHaveLength(3); // 100 + 100 + 30
    expect(new URL(g.calls.filter((c) => /\/messages\?/.test(c))[2]).searchParams.get('maxResults')).toBe('30');
  });
  it('gives what there is when there are fewer, a default of 100, and at most 500', async () => {
    expect(JSON.parse((await call('gmail_addin_list', { query: 'x', max: 400 }, fakeGoogle(40))).text)).toHaveLength(40);
    expect(JSON.parse((await call('gmail_addin_list', { query: 'x' })).text)).toHaveLength(100);
    expect(JSON.parse((await call('gmail_addin_list', { query: 'x', max: 9999 }, fakeGoogle(700))).text)).toHaveLength(500);
  });
  it('refuses an empty or over-long query before asking Gmail', async () => {
    for (const query of ['', '   ', 'x'.repeat(501), undefined]) {
      const r = await call('gmail_addin_list', { query });
      expect(r.out.result.isError).toBe(true);
      expect(r.g.calls).toHaveLength(0);
    }
  });
});

describe('fetch', () => {
  it('gives the message the way the parsers take it, with the HTML part when there is one', async () => {
    const g = fakeGoogle();
    const { text } = await call('gmail_addin_fetch', { id: g.ids[0] }, g);
    expect(JSON.parse(text)).toEqual({ id: g.ids[0], from: 'BCA <bca@bca.co.id>', subject: 'Transaction Journal', epochMs: 1793000000000, body: '<p>html version Rp 25.000</p>', isHtml: true });
  });
  it('decodes a part with the charset it declares (an old Windows encoding here), and says it is not HTML', async () => {
    const g = fakeGoogle();
    const m = JSON.parse((await call('gmail_addin_fetch', { id: g.ids[1] }, g)).text);
    expect(m).toMatchObject({ body: 'café', isHtml: false });
  });
  it('only a Gmail message id is accepted', async () => {
    for (const id of ['../x', 'abc?x=1', '', undefined, 'zz']) {
      const r = await call('gmail_addin_fetch', { id });
      expect(r.out.result.isError, String(id)).toBe(true);
      expect(r.g.calls, String(id)).toHaveLength(0);
    }
  });
  it('findBody: HTML first (depth first), else plain, else empty; an unknown charset falls back to UTF-8', () => {
    const html = { mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: utf8('p') } }, { mimeType: 'text/html', body: { data: utf8('<b>h</b>') } }] }] };
    expect(findBody(html)).toEqual({ body: '<b>h</b>', isHtml: true });
    expect(findBody({ mimeType: 'text/plain', body: { data: utf8('only plain') } })).toEqual({ body: 'only plain', isHtml: false });
    expect(findBody({ mimeType: 'multipart/mixed', parts: [] })).toEqual({ body: '', isHtml: false });
    expect(findBody(undefined)).toEqual({ body: '', isHtml: false });
    const odd = { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=made-up-9' }], body: { data: utf8('héllo') } };
    expect(findBody(odd).body).toBe('héllo');
  });
});
