#!/usr/bin/env python3
"""Runs the provider's own CLI sign-in on this Sprite for the shim (plan §7, D18). Never echoes the
Claude token; persists it only here. Prints only allowlisted sign-in URLs, device codes, masked
progress lines (for Settings to show) and the outcome. Reads codes to forward on stdin."""
import os, pty, re, select, subprocess, sys, fcntl, termios, struct, time
provider = sys.argv[1]
if provider not in ('claude', 'codex'): raise SystemExit('Choose claude or codex')
root = os.environ.get('CAPTAIN_ROOT', '/home/sprite/captain')
command = ['claude', 'setup-token'] if provider == 'claude' else ['codex', 'login', '--device-auth']
url_pattern = re.compile(r'https://(?:claude\.ai|claude\.com|platform\.claude\.com|console\.anthropic\.com|auth\.openai\.com)/[^\s\x1b<>]+')
device_pattern = re.compile(r'\b[A-Z0-9]{4}-[A-Z0-9]{4}\b')
token_pattern = re.compile(r'sk-ant-oat01-[A-Za-z0-9_-]+(?=[\r\n ])')
escapes = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]')
def mask(text): return re.sub(r'sk-ant-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{32,}|\*{6,}', '…', text)
def visible(text):
	lines = [l.strip() for l in escapes.sub('', text).replace('\r', '\n').split('\n')]
	return [l for l in lines if re.search(r'[A-Za-z]{3}', l) and 'https://' not in l and not l.startswith('***')]

master_fd, slave_fd = pty.openpty()
fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 4096, 0, 0))
def controlling():
	os.setsid(); fcntl.ioctl(0, termios.TIOCSCTTY, 0)
env = {'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'), 'HOME': os.environ.get('HOME', '/home/sprite'), 'LANG': 'C.UTF-8', 'TERM': 'xterm-256color'}
child = subprocess.Popen(command, stdin=slave_fd, stdout=slave_fd, stderr=slave_fd, cwd=root, env=env, preexec_fn=controlling)
os.close(slave_fd)
seen = set(); transcript = ''; sent_at = None; reported = set(); retry_pending = False
print('Sign-in started. Open the link below on your phone; paste a returned code back if Claude asks for it.', flush=True)
try:
	while child.poll() is None:
		ready, _, _ = select.select([master_fd, sys.stdin], [], [], 1)
		if sys.stdin in ready:
			line = sys.stdin.readline()
			if not line: break
			# The CLI's prompt is a terminal UI: the text first, then Enter as its own carriage return.
			# After a rejected code it waits on "Press Enter to retry": press it, let the prompt return, then type.
			if retry_pending: os.write(master_fd, b'\r'); time.sleep(1.5); retry_pending = False
			os.write(master_fd, line.rstrip('\r\n').encode()); time.sleep(0.3); os.write(master_fd, b'\r')
			sent_at = time.time(); reported.clear()
		if master_fd not in ready: continue
		try: data = os.read(master_fd, 8192).decode(errors='replace')
		except OSError: break
		transcript += data
		token = token_pattern.search(transcript)
		if token:
			fd = os.open(root + '/claude-token', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
			with os.fdopen(fd, 'w') as file: file.write(token.group(0))
			print('Claude login saved on the Sprite.', flush=True)
			break
		for value in url_pattern.findall(transcript):
			if value not in seen: print(value, flush=True); seen.add(value)
		for value in device_pattern.findall(escapes.sub('', transcript)):
			if value not in seen: print('Device code: ' + value, flush=True); seen.add(value)
		# After a code is sent, report what the CLI says next, masked, so Settings can show why a sign-in ended.
		if sent_at is not None:
			for value in visible(data)[-3:]:
				if 'Press Enter to retry' in value: retry_pending = True
				if value not in reported: print('CLI: ' + mask(value)[:160], flush=True); reported.add(value)
		transcript = transcript[-32768:]
finally:
	if child.poll() is None: child.terminate()
	child.wait(); os.close(master_fd)
	for value in visible(transcript)[-2:]:
		if value not in reported: print('CLI: ' + mask(value)[:160], flush=True)
	print('CLI exited ' + str(child.returncode), flush=True)
if provider == 'codex':
	result = subprocess.run(['codex', 'login', 'status'], capture_output=True)
	print('Codex login saved on the Sprite.' if result.returncode == 0 else 'Sign-in did not finish; run this command again.', flush=True)
