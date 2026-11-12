// The Gmail layer checks message ids itself (the tool layer checks them too): an id that is not a Gmail id never becomes part of an API address.
import { describe, expect, it } from 'vitest';
import { fetchMessage, read } from '../src/gmail.js';

const env = { GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', REFRESH_ADDIN: 'r' };
const calls = [];
const opts = { fetchImpl: async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ access_token: 't', expires_in: 3600, id: 'x', payload: { headers: [], mimeType: 'text/plain', body: { data: '' } } }), { status: 200, headers: { 'content-type': 'application/json' } }); }, now: () => 1000 };

describe('message ids in the Gmail layer', () => {
  it('refuses anything that could change the address: slashes, dots, query and fragment characters', async () => {
    for (const id of ['../settings/filters', 'x?format=raw#', '1a2b3c4d/../../x', '', 'zzzzzzzzzz', '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f']) {
      await expect(read(env, 'addin', id, opts), id).rejects.toThrow('bad message id');
      await expect(fetchMessage(env, 'addin', id, opts), id).rejects.toThrow('bad message id');
    }
    expect(calls.filter((u) => u.includes('/messages/'))).toEqual([]);
  });
  it('lets a real hex id through to the Gmail address', async () => {
    await read(env, 'addin', '1a2b3c4d5e6f7a8b', opts).catch(() => {});
    expect(calls.some((u) => u.endsWith('/messages/1a2b3c4d5e6f7a8b?format=full'))).toBe(true);
  });
});
