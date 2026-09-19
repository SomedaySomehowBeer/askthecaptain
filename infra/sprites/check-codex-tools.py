#!/usr/bin/env python3
"""Run on an isolated test host/Sprite with a generated catalog. No real model request.
Usage: python3 check-codex-tools.py /home/sprite/captain/catalog.json /path/to/codex.toml
The endpoint is a localhost mock; logs/state go to a temporary directory.
"""
import json, os, subprocess, sys, tempfile, threading, tomllib
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
catalog = Path(sys.argv[1]).resolve(); config = tomllib.loads(Path(sys.argv[2]).read_text())
assert subprocess.check_output(['codex', '--version'], text=True).strip() == 'codex-cli 0.154.0'
with tempfile.TemporaryDirectory(prefix='captain-tools-') as temp:
 root = Path(temp); observed = []
 class Handler(BaseHTTPRequestHandler):
  def log_message(self, *args): pass
  def do_POST(self):
   data = json.loads(self.rfile.read(int(self.headers['content-length'])))
   observed.append(data.get('tools'))
   self.send_response(400); self.end_headers(); self.wfile.write(b'{"error":{"message":"offline probe complete"}}')
 server = HTTPServer(('127.0.0.1', 0), Handler)
 threading.Thread(target=server.serve_forever, daemon=True).start()
 def flatten(value, prefix=''):
  for key, item in value.items():
   name = prefix + key
   if isinstance(item, dict): yield from flatten(item, name + '.')
   else: yield name + '=' + json.dumps(item)
 overrides = list(flatten(config)) + [
  'model_provider="captain_probe"', 'model_providers.captain_probe.name="Offline probe"',
  f'model_providers.captain_probe.base_url="http://127.0.0.1:{server.server_port}/v1"',
  'model_providers.captain_probe.wire_api="responses"', 'model_providers.captain_probe.requires_openai_auth=false',
  'model_providers.captain_probe.request_max_retries=0', f'model_catalog_json={json.dumps(str(catalog))}',
  f'log_dir={json.dumps(temp)}', f'sqlite_home={json.dumps(temp)}']
 try:
  for model in ['gpt-5.6-luna', 'gpt-6-astra']:
   observed.clear()
   args = ['codex', 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', temp, '--model', model]
   for override in overrides: args += ['-c', override]
   subprocess.run(args + ['Return only {}.'], env={k:v for k,v in os.environ.items() if k in ('PATH', 'HOME', 'LANG')}, capture_output=True, timeout=30)
   assert observed and all(tools == [] for tools in observed), 'Missing request or nonempty tool list'
   print(model + ': tools=[] (offline request captured)')
 finally: server.shutdown()
