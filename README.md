# household-mail: Gmail reader for Claude on a Cloudflare Worker

Replaces a self-hosted n8n server for one job: Claude reads the household's Gmail, read-only, with every computer off.

- Live at `https://<your-worker>.workers.dev/mcp` (MCP over HTTP, POST only, `Authorization: Bearer <token>`; anything else gets 401/404/405).
- Tools (same names as the n8n ones): `gmail_<who>_search {query, max}`, `gmail_<who>_read {id}`, `gmail_<who>_whoami` for who = `addin`, `muthia1`, `muthia2`. Scope is `gmail.readonly`: it cannot send, delete or change mail.
- Secrets live only in Cloudflare (Worker secrets): `MCP_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `REFRESH_ADDIN`, `REFRESH_MUTHIA1`, `REFRESH_MUTHIA2`. The bearer token is also in `secrets/mcp-token.txt` (git-ignored) for Claude Code's config.
- Free plan: a request here does very little CPU (the 10 ms limit is fine); search of 25 mails makes 26 Gmail calls (limit 50).

## Use from Claude Code (PowerShell, once)

    claude mcp add --transport http --scope user gmail-cloudflare https://<your-worker>.workers.dev/mcp --header "Authorization: Bearer $((Get-Content 'secrets\mcp-token.txt').Trim())"

## Operations

- Tests: `npm test` (fake Gmail, no network). Real check: `node scripts/remote-check.mjs` (masked output).
- Deploy: `npm run deploy`. Change a secret: `wrangler secret put NAME`. Rotate the bearer token: new random value, `wrangler secret put MCP_TOKEN`, update `secrets/mcp-token.txt` and Claude's config.
- Revoke a person: https://myaccount.google.com/permissions on that account (then the Worker answers "the sign-in expired or was revoked"); remove the secret with `wrangler secret delete REFRESH_<WHO>`.
- The refresh tokens were copied once from the old n8n database (that server and its data are deleted). If the Google app is in "Testing" status, Google expires refresh tokens after 7 days: if a call says "sign in to Google again", publish the app or sign in again with a new small OAuth script (the client id and secret are the Worker secrets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).
