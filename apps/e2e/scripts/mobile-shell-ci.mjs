/** Serve the already-exported mobile web shell on loopback for its browser approximation.
 * No API, credentials, fixture database or native runtime is involved. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const files = path.join(root, 'apps/mobile/dist/web');
await stat(path.join(files, 'index.html'));
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' };
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
const port = server.address().port;
const child = spawn(process.execPath, [path.join(root, 'apps/e2e/scripts/mobile-shell-check.cjs')], {
  cwd: root, detached: true, stdio: 'inherit', env: { ...process.env, MOBILE_SHELL_URL: `http://127.0.0.1:${port}` }
});
const signalGroup = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* already stopped */ } } };
const stop = () => signalGroup('SIGTERM');
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const timer = setTimeout(() => signalGroup('SIGKILL'), 180_000);
try {
  process.exitCode = await new Promise(resolve => {
    child.once('error', () => resolve(1));
    child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  clearTimeout(timer); server.closeAllConnections(); server.close();
}
