// The address of your deployed Worker, kept out of the repository: set MAIL_URL, or put it in secrets/worker-url.txt (git-ignored).
import { existsSync, readFileSync } from 'node:fs';

const file = new URL('../secrets/worker-url.txt', import.meta.url);
export function workerUrl(arg) {
  const v = arg || process.env.MAIL_URL || (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
  if (!v) throw new Error('give the Worker address as an argument, set MAIL_URL, or write it to secrets/worker-url.txt');
  return v.replace(/\/$/, '').replace(/\/mcp$/, '') + '/mcp';
}
