// OWNER: run ON THE SPRITE. Secrets travel directly to the API over TLS, never through stdout.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
try {
 const api = new URL(await prompt.question('Captain API origin (https): '));
 if (api.protocol !== 'https:') throw Error('HTTPS required');
 const organisation = await prompt.question('Captain organisation UUID: ');
 const url = await prompt.question('Exact Sprite HTTPS URL (sprite url): ');
 const spriteName = await prompt.question('Sprite name: ');
 const region = await prompt.question('Region reported by the Sprite service (or unknown): ');
 const loginHint = (await prompt.question('Subscription account email (optional): ')) || null;
 const loginUrl = (await prompt.question('Current sign-in URL from login.py (optional): ')) || null;
 let session;
 execFileSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] });
 try { session = await prompt.question('Owner session token (hidden): '); } finally { execFileSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] }); console.log(); }
 const { secret } = JSON.parse(await readFile((process.env.CAPTAIN_ROOT ?? '/home/sprite/captain') + '/runtime.json', 'utf8'));
 const result = await fetch(new URL(`/v1/organisations/${encodeURIComponent(organisation)}/inference/runtime/configure`, api), {
  method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' },
  body: JSON.stringify({ url, secret, spriteName, region, loginHint, loginUrl }), signal: AbortSignal.timeout(30000)
 });
 console.log(result.ok ? 'Runtime attached. Complete sign-in, then verify in Settings.' : `Registration failed (HTTP ${result.status}). Check the owner session and organisation.`);
} finally { prompt.close(); }
