// Gmail over its REST API, read-only (scope gmail.readonly). One refresh token per account lives in a Worker secret.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ID = /^[0-9a-f]{8,32}$/i;
const checked = (id) => { if (!ID.test(String(id))) throw new Error('bad message id'); return id; }; // the tool layer checks too; this layer must not rely on its callers
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY = 200000; // characters of a mail body handed back

/** Access tokens last about an hour: kept per account inside this isolate, so most calls make no token request. */
const cache = new Map();

export async function accessToken(env, who, { fetchImpl = fetch, now = Date.now } = {}) {
  const hit = cache.get(who);
  if (hit && hit.exp - 60000 > now()) return hit.token;
  const refresh = env[`REFRESH_${who.toUpperCase()}`];
  if (!refresh) throw new Error(`${who} is not connected here (no sign-in stored)`);
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const why = data.error === 'invalid_grant' ? 'the sign-in expired or was revoked: sign in to Google again' : `Google refused (${data.error || res.status})`;
    throw new Error(`${who}: ${why}`);
  }
  cache.set(who, { token: data.access_token, exp: now() + (Number(data.expires_in) || 3600) * 1000 });
  return data.access_token;
}

export const forgetTokens = () => cache.clear();

async function api(env, who, path, opts) {
  const token = await accessToken(env, who, opts);
  const res = await (opts?.fetchImpl || fetch)(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    cache.delete(who); // a stale token is the usual cause: the next call asks for a new one
    throw new Error(`Gmail answered ${res.status} for ${who}`);
  }
  return res.json();
}

const header = (msg, name) => ((msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';
const dateOf = (msg) => (msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : header(msg, 'Date'));

/** Gmail search (the same syntax as the Gmail box). Returns the newest `max` mails with sender, subject, date and a snippet. */
export async function search(env, who, query, max, opts) {
  const list = await api(env, who, `/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`, opts);
  const ids = (list.messages || []).map((m) => m.id);
  const metadata = '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date';
  const msgs = await Promise.all(ids.map((id) => api(env, who, `/messages/${id}${metadata}`, opts)));
  return [{
    messages: msgs.map((m) => ({ id: m.id, threadId: m.threadId, from: header(m, 'From'), subject: header(m, 'Subject'), date: dateOf(m), snippet: m.snippet || '' })),
  }];
}

const fromBase64Url = (s) => {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

const stripHtml = (html) => html
  .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n\s*\n+/g, '\n').trim();

/** The text of a mail: its text/plain part when there is one, else its HTML with the tags taken out. */
export function bodyOf(payload) {
  const found = { plain: '', html: '' };
  const walk = (p) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data && !found.plain) found.plain = fromBase64Url(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data && !found.html) found.html = fromBase64Url(p.body.data);
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  const text = found.plain.trim() ? found.plain : stripHtml(found.html);
  return text.slice(0, MAX_BODY);
}

export async function read(env, who, id, opts) {
  const m = await api(env, who, `/messages/${checked(id)}?format=full`, opts);
  return [{ id: m.id, threadId: m.threadId, from: header(m, 'From'), to: header(m, 'To'), subject: header(m, 'Subject'), date: dateOf(m), body: bodyOf(m.payload) }];
}

export async function whoami(env, who, opts) {
  const p = await api(env, who, '/profile', opts);
  return { emailAddress: p.emailAddress };
}

// ---- for the Cashflow sync: the same two calls the Apps Script version makes (list ids, fetch one message as the parsers expect it) ----

/** Message ids matching a Gmail query, newest first, following the pages (at most `max`, at most 500). */
export async function listIds(env, who, query, max, opts) {
  const ids = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(100, max - ids.length)) });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await api(env, who, `/messages?${params}`, opts);
    (page.messages || []).forEach((m) => ids.push(m.id));
    pageToken = page.nextPageToken || '';
  } while (pageToken && ids.length < max);
  return ids;
}

const charsetOf = (part) => {
  const type = ((part.headers || []).find((h) => h.name.toLowerCase() === 'content-type') || {}).value || '';
  const m = /charset="?([^";\s]+)"?/i.exec(type);
  return m ? m[1] : 'utf-8';
};

/** Bytes of a base64url part decoded with the charset the part declares (utf-8 when unknown). */
function decodePart(part) {
  const data = part.body && part.body.data;
  if (!data) return '';
  const bin = atob(String(data).replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  try { return new TextDecoder(charsetOf(part)).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

/** Like the Apps Script reader: depth first, the first HTML part wins, else the first plain part. */
export function findBody(payload) {
  let html = null;
  let text = null;
  const walk = (p) => {
    if (!p) return;
    const type = String(p.mimeType || '').toLowerCase();
    if (type === 'text/html' && !html) html = p;
    else if (type === 'text/plain' && !text) text = p;
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  if (html) return { body: decodePart(html), isHtml: true };
  if (text) return { body: decodePart(text), isHtml: false };
  return { body: '', isHtml: false };
}

/** One message in the shape the Cashflow parsers take: { id, from, subject, epochMs, body, isHtml }. */
export async function fetchMessage(env, who, id, opts) {
  const m = await api(env, who, `/messages/${checked(id)}?format=full`, opts);
  const { body, isHtml } = findBody(m.payload);
  return { id: m.id, from: header(m, 'From'), subject: header(m, 'Subject'), epochMs: Number(m.internalDate), body, isHtml };
}
