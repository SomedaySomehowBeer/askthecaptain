import assert from 'node:assert/strict';
import { test } from 'node:test';
import { command, parseOutput, server } from './shim.mjs';
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
