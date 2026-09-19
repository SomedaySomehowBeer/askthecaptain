#!/usr/bin/env python3
"""Owner-only interactive login. Never echo the Claude token; persist it only on this Sprite."""
import os, pty, re, select, subprocess, sys, fcntl, termios, struct, time
sent_at = None
mask = lambda text: re.sub(r'sk-ant-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{32,}', '…', text)
provider = sys.argv[1]
if provider not in ('claude', 'codex'): raise SystemExit('Choose claude or codex')
master_fd, slave_fd = pty.openpty()
fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 4096, 0, 0))
command = ['claude', 'setup-token'] if provider == 'claude' else ['codex', 'login', '--device-auth']
root = os.environ.get('CAPTAIN_ROOT', '/home/sprite/captain')
child = subprocess.Popen(command, stdin=slave_fd, stdout=slave_fd, stderr=slave_fd, cwd=root, start_new_session=True)
os.close(slave_fd)
seen = set(); transcript = ''
print('Open the sign-in link below (also available in Settings once registered). Follow its instructions; paste a returned code here if Claude asks for it.', flush=True)
try:
 while child.poll() is None:
  ready, _, _ = select.select([master_fd, sys.stdin], [], [], 1)
  if sys.stdin in ready:
   line = sys.stdin.readline()
   if not line: break
   # The CLI's prompt is a terminal UI: Enter is a carriage return, not a newline.
   os.write(master_fd, line.rstrip('\r\n').encode() + b'\r')
   sent_at = time.time()
  if master_fd not in ready: continue
  try: data = os.read(master_fd, 8192).decode(errors='replace')
  except OSError: break
  transcript += re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', data)
  token = re.search(r'sk-ant-oat01-[A-Za-z0-9_-]+(?=[\r\n ])', transcript)
  if token:
   fd = os.open(root + '/claude-token', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
   with os.fdopen(fd, 'w') as file: file.write(token.group(0))
   print('Claude login saved on the Sprite.', flush=True)
   break
  # Emit only allowlisted login URLs and device user codes, never arbitrary CLI output.
  for value in re.findall(r'https://(?:claude\.ai|claude\.com|platform\.claude\.com|console\.anthropic\.com|auth\.openai\.com)/[^\s\x1b<>]+', transcript):
   if value not in seen: print(value, flush=True); seen.add(value)
  for value in re.findall(r'\b[A-Z0-9]{4}-[A-Z0-9]{4}\b', transcript):
   if value not in seen: print('Device code: ' + value, flush=True); seen.add(value)
  # After a code is sent, report what the CLI says next, masked, so Settings can show why a sign-in ended.
  if sent_at is not None:
   for value in [l.strip() for l in re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', data).split('\n') if l.strip()][-3:]:
    if 'https://' not in value and value not in seen: print('CLI: ' + mask(value)[:160], flush=True); seen.add(value)
  transcript = transcript[-32768:]
finally:
 if child.poll() is None: child.terminate()
 child.wait(); os.close(master_fd)
 print('CLI exited ' + str(child.returncode), flush=True)
if provider == 'codex':
 result = subprocess.run(['codex', 'login', 'status'], capture_output=True)
 print('Codex login saved on the Sprite.' if result.returncode == 0 else 'Sign-in did not finish; run this command again.')
