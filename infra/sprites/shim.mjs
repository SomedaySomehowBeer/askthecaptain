import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
const root = '/opt/captain';
const failure = code => Object.assign(new Error(code), { code });
export function command(request, directory) {
 const common = { cwd: directory, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/sprite', LANG: 'C.UTF-8' } };
 if (request.provider === 'claude') return { ...common, binary: 'claude', args: ['-p', '--model', request.model, '--output-format', 'json', '--json-schema', JSON.stringify(request.schema), '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--system-prompt', request.instruction], env: { ...common.env, CLAUDE_CONFIG_DIR: `${directory}/claude`, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxTokens), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } };
 return { ...common, binary: 'codex', args: ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never', '--model', request.model, '-c', `model_catalog_json="${root}/catalog.json"`, '-c', `model_instructions_file="${directory}/instruction.txt"`, '-c', `log_dir="${directory}/logs"`, '-c', `sqlite_home="${directory}/state"`, '--output-schema', `${directory}/schema.json`, '-'] };
}
function run(spec, input) {
 return new Promise((resolve, reject) => {
  const child = spawn(spec.binary, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 100000);
  const collect = target => chunk => { size += chunk.length; if (size > 1048576) { expired = true; child.kill('SIGKILL'); } else if (target === 'out') stdout += chunk; else stderr += chunk; };
  child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
  child.on('error', () => { clearTimeout(timer); reject(failure('provider_unavailable')); });
  child.on('close', code => {
   clearTimeout(timer);
   if (expired) return reject(failure('provider_unavailable'));
   if (code !== 0) {
    const text = stdout + stderr;
    return reject(failure(/rate.limit|usage.limit|429/i.test(text) ? 'rate_limited' : /not.logged|login|authentication|401|oauth.*expired/i.test(text) ? 'needs_login' : 'provider_unavailable'));
   }
   resolve(stdout);
  });
  child.stdin.on('error', () => {}); child.stdin.end(input);
 });
}
export function parseOutput(provider, raw, requestedModel, latencyMs) {
 let output, usage, model = requestedModel;
 if (provider === 'claude') {
  const result = JSON.parse(raw);
  if (result.is_error) throw failure(/rate.limit|usage.limit/i.test(JSON.stringify(result)) ? 'rate_limited' : 'provider_unavailable');
  output = result.structured_output;
  if (output === undefined) { try { output = JSON.parse(result.result); } catch { output = result.result; } }
  usage = { inputTokens: result.usage?.input_tokens + (result.usage?.cache_read_input_tokens ?? 0) + (result.usage?.cache_creation_input_tokens ?? 0), outputTokens: result.usage?.output_tokens };
  const reported = Object.keys(result.modelUsage ?? {}); if (reported.length === 1) model = reported[0];
 } else {
  for (const line of raw.trim().split('\n')) {
   const event = JSON.parse(line);
   if (event.type === 'item.completed' && event.item?.type === 'agent_message') { try { output = JSON.parse(event.item.text); } catch { output = event.item.text; } }
   if (event.type === 'turn.completed') usage = { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens };
   // Defence in depth: do not accept a session which advertised an unexpected tool action.
   if (event.item && !['agent_message', 'reasoning'].includes(event.item.type)) throw failure('provider_unavailable');
  }
 }
 if (!usage || !Object.values(usage).every(v => Number.isSafeInteger(v) && v >= 0)) throw failure('provider_unavailable');
 return { output, usage, model, latencyMs };
}
export async function invoke(request) {
 const directory = await mkdtemp('/dev/shm/captain-infer-'); const started = Date.now();
 try {
  await writeFile(`${directory}/schema.json`, JSON.stringify(request.schema), { mode: 0o600 });
  await writeFile(`${directory}/instruction.txt`, request.instruction, { mode: 0o600 });
  if (request.provider === 'codex') {
   const { models } = JSON.parse(await readFile(`${root}/catalog.json`, 'utf8'));
   const model = models.find(m => m.slug === request.model);
   if (!model || model.apply_patch_tool_type !== null || model.experimental_supported_tools.length || model.shell_type !== 'disabled' || model.tool_mode !== null) throw failure('runtime_not_ready');
  }
  const spec = command(request, directory);
  if (request.provider === 'claude') {
   try { spec.env.CLAUDE_CODE_OAUTH_TOKEN = (await readFile(`${root}/claude-token`, 'utf8')).trim(); } catch { throw failure('needs_login'); }
  }
  return parseOutput(request.provider, await run(spec, request.input), request.model, Date.now() - started);
 } finally { await rm(directory, { recursive: true, force: true }); }
}
export function server(secret, provider, inference = invoke) {
 let busy = false;
 return createServer(async (req, res) => {
  const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from(`Bearer ${secret}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { code: 'runtime_not_ready' });
  if (req.url === '/health' && req.method === 'GET') return send(200, { ok: true });
  if (req.url !== '/infer' || req.method !== 'POST') return send(404, { code: 'not_found' });
  if (busy) return send(429, { code: 'rate_limited' });
  busy = true;
  try {
   let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 262144) return send(413, { code: 'invalid_request' }); }
   const input = JSON.parse(body);
   if (input.provider !== provider || !/^[a-zA-Z0-9.-]{1,100}$/.test(input.model) || typeof input.instruction !== 'string' || typeof input.input !== 'string' || !input.schema || typeof input.schema !== 'object' || !Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 16384) return send(400, { code: 'invalid_request' });
   send(200, await inference(input));
  } catch (e) { const code = ['needs_login', 'rate_limited'].includes(e.code) ? e.code : 'provider_unavailable'; send(code === 'rate_limited' ? 429 : 503, { code }); }
  finally { busy = false; }
 });
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
 if (execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim() !== 'codex-cli 0.154.0' || !execFileSync('claude', ['--version'], { encoding: 'utf8' }).startsWith('2.1.272 ')) throw Error('Pinned CLI versions required');
 const { secret, provider } = JSON.parse(await readFile(`${root}/runtime.json`, 'utf8'));
 if (!/^[a-f0-9]{64}$/.test(secret) || !['claude', 'codex'].includes(provider)) throw Error('Invalid runtime configuration');
 server(secret, provider).listen(8080, '0.0.0.0');
}
