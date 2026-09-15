import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
// Runtime metadata only. Never copy provider instructions or tool definitions into Captain.
if (execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim() !== 'codex-cli 0.154.0') throw Error('Codex version must be 0.154.0');
const { models } = JSON.parse(execFileSync('codex', ['debug', 'models'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
for (const model of models) Object.assign(model, {
 apply_patch_tool_type: null, experimental_supported_tools: [], shell_type: 'disabled', tool_mode: null, multi_agent_version: null,
 supports_search_tool: false, model_messages: null, base_instructions: 'Return schema-conforming JSON data only.',
 use_responses_lite: false, prefer_websockets: false, include_skills_usage_instructions: false, include_apps_usage_instructions: false, include_plugin_usage_instructions: false
});
writeFileSync('/opt/captain/catalog.json', JSON.stringify({ models }), { mode: 0o600 });
