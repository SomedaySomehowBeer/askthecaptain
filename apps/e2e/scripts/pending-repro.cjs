// Diagnostic matrix for #11; not part of CI and does not claim to reproduce the bug.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const { createHash } = require('node:crypto');

const origin = process.env.PROBE_ORIGIN || 'http://127.0.0.1:3108';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)) {
  throw new Error('Use a loopback origin for this diagnostic.');
}
const cases = JSON.parse(process.env.PROBE_CASES || '[{"n":0},{"n":1},{"n":20},{"n":70},{"n":150},{"n":350},{"n":70,"refresh":0},{"n":350,"refresh":0}]');
const repeats = Number(process.env.PROBE_REPEATS || 4);
const idle = Number(process.env.PROBE_IDLE || 12000);

(async () => {
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--disable-dev-shm-usage'],
  });
  try {
    for (const config of cases) {
      for (let attempt = 0; attempt < repeats; attempt++) {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [], responses = [], reads = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        page.on('response', (response) => {
          if (response.request().method() !== 'POST') return;
          const record = { status: response.status(), contentType: response.headers()['content-type'] };
          responses.push(record);
          reads.push((async () => {
            try {
              const body = await response.body();
              Object.assign(record, { complete: true, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
            } catch (error) {
              // CDP can evict a response body on a passing case; this is not a browser error.
              record.captureError = error.message;
            }
          })());
        });
        await page.goto(`${origin}/dev/pending?${new URLSearchParams({ ...config, attempt })}`);
        const button = page.locator('#probe button');
        await button.waitFor();
        await page.waitForTimeout(idle);
        const started = Date.now();
        await button.click();
        let settled = true;
        try {
          await page.waitForFunction(() => document.querySelector('#probe output')?.dataset.count === '1'
            && !document.querySelector('#probe button')?.disabled, {}, { timeout: 10000 });
        } catch { settled = false; }
        await Promise.all(reads);
        console.log(JSON.stringify({ config, attempt, idle, settled, elapsedMs: Date.now() - started,
          formCount: await page.locator('form').count(), errors, responses }));
        if (!settled) {
          await page.screenshot({ path: `pending-${config.n}-${attempt}.png` });
          fs.writeFileSync(`pending-${config.n}-${attempt}.html`, await page.content());
        }
        await context.close();
      }
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
