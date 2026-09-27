/** Serve separate production and scripted-account web exports on loopback for browser checks.
 * No API, credentials, fixture database or native runtime is involved. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' };
async function serve(relative) {
  const files = path.join(root, relative);
  await stat(path.join(files, 'index.html'));
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let file = path.resolve(files, '.' + pathname);
      if (!file.startsWith(files + path.sep) && file !== files) { response.writeHead(400).end(); return; }
      if (!(await stat(file).then(s => s.isFile(), () => false))) file = path.join(files, 'index.html');
      response.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(await readFile(file));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const servers = [];
try {
  const production = await serve('apps/mobile/dist/web'); servers.push(production.server);
  const harness = await serve('apps/mobile/dist-harness'); servers.push(harness.server);
  const child = spawn(process.execPath, [path.join(root, 'apps/e2e/scripts/mobile-shell-check.cjs')], {
    cwd: root, detached: true, stdio: 'inherit', env: { ...process.env, MOBILE_SHELL_URL: harness.url, MOBILE_PRODUCTION_URL: production.url }
  });
  const signalGroup = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* already stopped */ } } };
  const stop = () => signalGroup('SIGTERM');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const timer = setTimeout(() => { console.error('mobile shell check exceeded 600 seconds; stopping its process group'); signalGroup('SIGKILL'); }, 600_000);
  try {
    process.exitCode = await new Promise(resolve => {
      child.once('error', () => resolve(1));
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    clearTimeout(timer);
  }
} finally {
  for (const server of servers) { server.closeAllConnections(); server.close(); }
}
