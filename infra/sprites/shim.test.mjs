import assert from 'node:assert/strict';
import { test } from 'node:test';
import { command, loginManager, parseOutput, server } from './shim.mjs';
import { spawn } from 'node:child_process';
const request = { provider: 'claude', model: 'claude-sonnet-5', instruction: 'Classify', input: 'data', schema: { type: 'object' }, maxTokens: 32 };
test('CLI has no tool/config inheritance and uses instruction/schema flags', () => {
 const claude = command(request, '/tmp/test'); assert.equal(claude.args[claude.args.indexOf('--tools') + 1], ''); assert.ok(claude.args.includes('--strict-mcp-config')); assert.ok(claude.args.includes('--no-session-persistence'));
 assert.equal(claude.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '32'); assert.ok(!('OPENAI_API_KEY' in claude.env));
 const codex = command({ ...request, provider: 'codex' }, '/tmp/test'); assert.ok(codex.args.includes('read-only')); assert.ok(codex.args.includes('--output-schema')); assert.ok(codex.args.includes('--ephemeral'));
});
test('normalizes cached Claude usage and Codex JSONL; rejects tool events and missing usage', () => {
 const output = { urgent: true };
 assert.deepEqual(parseOutput('claude', JSON.stringify({ structured_output: output, usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 3 } }), 'model', 7).usage, { inputTokens: 35, outputTokens: 3 });
 const raw = [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(output) } }, { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5 } }].map(x => JSON.stringify(x)).join('\n');
 assert.deepEqual(parseOutput('codex', raw, 'model', 9).output, output);
 assert.throws(() => parseOutput('codex', '{"type":"item.completed","item":{"type":"command_execution"}}', 'model', 1));
 assert.throws(() => parseOutput('claude', '{"result":"oops"}', 'model', 1));
});
test('all shim routes require the per-Sprite secret; wrong provider never invokes a CLI', async () => {
 let calls = 0; const app = server('test-secret', 'claude', async () => { calls++; return { output: {} }; });
 await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
 const url = `http://127.0.0.1:${app.address().port}`;
 try {
  for (const path of ['/health', '/infer', '/']) assert.equal((await fetch(url + path)).status, 401);
  assert.equal((await fetch(url + '/health', { headers: { authorization: 'Bearer test-secret' } })).status, 200);
  assert.equal((await fetch(url + '/infer', { method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: JSON.stringify({ ...request, provider: 'codex' }) })).status, 400);
  assert.equal(calls, 0);
 } finally { await new Promise(resolve => app.close(resolve)); }
});
const fakeLogin = (lines, doneOn) => () => spawn(process.execPath, ['-e', `
 const lines = ${JSON.stringify(lines)}; for (const l of lines) console.log(l);
 process.stdin.on('data', d => { if (String(d).trim() === ${JSON.stringify(doneOn)}) { console.log('Claude login saved on the Sprite.'); process.exit(0); } else { console.log('Sign-in did not finish; run this command again.'); process.exit(1); } });
`], { stdio: ['pipe', 'pipe', 'pipe'] });
const settle = () => new Promise(resolve => setTimeout(resolve, 150));
test('login exposes only the allowlisted URL and device code, forwards one code to the CLI, and reports the outcome', async () => {
 const login = loginManager('claude', fakeLogin(['noise https://evil.test/steal?x=1', '\x1b]8;id=1;https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\x1b\\link\x1b]8;;\x1b\\', 'Device code: ABCD-1234', 'secret token sk-ant-oat01-NEVER'], 'good#code'));
 assert.deepEqual(login.status(), { state: 'idle', url: null, code: null, needsCode: true, note: null });
 assert.equal(login.start().state, 'waiting'); await settle();
 const waiting = login.status(); assert.equal(waiting.url, 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz'); assert.equal(waiting.code, 'ABCD-1234');
 assert.ok(!JSON.stringify(waiting).includes('evil') && !JSON.stringify(waiting).includes('sk-ant'));
 login.code('good#code'); await settle(); assert.equal(login.status().state, 'done');
 const noted = loginManager('claude', fakeLogin(['CLI: Invalid code, try again', 'CLI: token sk-ant-oat01-SECRETSECRETSECRETSECRETSECRET here'], 'never')); noted.start(); await settle();
 assert.equal(noted.status().note, 'CLI: Invalid code, try again · CLI: token … here'); noted.stop();
 const crashing = loginManager('claude', () => spawn(process.execPath, ['-e', 'console.error("Traceback (most recent call last):\\n  File x\\nOSError: [Errno 1] Operation not permitted"); process.exit(1)'], { stdio: ['pipe', 'pipe', 'pipe'] })); crashing.start(); await settle();
 assert.equal(crashing.status().state, 'failed'); assert.equal(crashing.status().note, 'wrapper: OSError: [Errno 1] Operation not permitted');
 assert.throws(() => login.code('again'), { code: 'invalid_request' });
 const saved = loginManager('claude', fakeLogin(['https://claude.com/x'], 'never'), () => true);
 assert.equal(saved.status().state, 'done'); assert.equal(saved.start().state, 'waiting'); saved.stop();
 const failing = loginManager('codex', fakeLogin(['Device code: WXYZ-9876'], 'other')); failing.start(); await settle();
 assert.equal(failing.status().needsCode, false); failing.code('wrong'); await settle(); assert.equal(failing.status().state, 'failed');
 login.stop(); failing.stop();
});
test('a failed probe carries the runtime\'s masked one-line account; ordinary requests carry only the code', async () => {
 const failing = async () => { throw Object.assign(new Error('provider_unavailable'), { code: 'provider_unavailable', detail: 'exit 1: token sk-ant-oat01-SECRETSECRETSECRETSECRET rejected' }); };
 const app = server('s', 'claude', failing); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
 const url = `http://127.0.0.1:${app.address().port}`; const headers = { authorization: 'Bearer s', 'content-type': 'application/json' };
 try {
  const plain = await (await fetch(url + '/infer', { method: 'POST', headers, body: JSON.stringify(request) })).json();
  assert.deepEqual(plain, { code: 'provider_unavailable' });
  const probe = await (await fetch(url + '/infer', { method: 'POST', headers, body: JSON.stringify({ ...request, probe: true }) })).json();
  assert.deepEqual(probe, { code: 'provider_unavailable', detail: 'exit 1: token sk-ant-oat01-SECRETSECRETSECRETSECRET rejected' });
  assert.equal((await fetch(url + '/infer', { method: 'POST', headers, body: JSON.stringify({ ...request, probe: 'yes' }) })).status, 400);
 } finally { await new Promise(resolve => app.close(resolve)); }
});
test('login routes sit behind the secret and validate the code shape', async () => {
 const login = loginManager('claude', fakeLogin(['https://platform.claude.com/x'], 'ok#code1'));
 const app = server('s', 'claude', async () => ({}), login); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
 const url = `http://127.0.0.1:${app.address().port}`; const auth = { authorization: 'Bearer s', 'content-type': 'application/json' };
 try {
  assert.equal((await fetch(url + '/login/status')).status, 401);
  assert.equal((await fetch(url + '/login/start', { method: 'POST', headers: auth })).status, 200); await settle();
  assert.equal((await (await fetch(url + '/login/status', { headers: auth })).json()).url, 'https://platform.claude.com/x');
  assert.equal((await fetch(url + '/login/code', { method: 'POST', headers: auth, body: JSON.stringify({ code: 'bad code with spaces' }) })).status, 400);
  assert.equal((await fetch(url + '/login/code', { method: 'POST', headers: auth, body: JSON.stringify({ code: 'ok#code1' }) })).status, 200); await settle();
  assert.equal((await (await fetch(url + '/login/status', { headers: auth })).json()).state, 'done');
 } finally { login.stop(); await new Promise(resolve => app.close(resolve)); }
});

