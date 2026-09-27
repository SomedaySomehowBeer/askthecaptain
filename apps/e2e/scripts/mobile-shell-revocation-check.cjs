/** Account session-control UI with a synthetic runner source; not native/device or real API proof. */
const { expect } = require('@playwright/test');
module.exports = async ({ getPage, freshPage, scenario, shot, noOverflow, width }) => {
 const page = () => getPage();
 const id = name => page().locator(`[data-testid="${name}"]:visible`);
 const action = () => id('account-action-revoke-others');
 const status = () => id('account-revoke-others-status');
 const count = async n => expect.poll(async () => JSON.parse(await page().getByTestId('account-revoke-log').textContent()).length).toBe(n);
 const answer = name => page().getByTestId(`harness-revoke-${name}`).click();
 const openAccount = () => page().getByRole('button', { name: 'Account and settings', exact: true }).click();
 const roundTrip = async () => {
  await page().getByRole('button', { name: 'Back', exact: true }).click();
  await openAccount(); await expect(page().getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
 };
 const send = async n => {
  await action().click(); await id('account-action-revoke-others-confirm').click(); await count(n);
 };
 await freshPage(); await page().clock.install(); await page().clock.pauseAt(await page().evaluate(() => Date.now()));
 await scenario('ready', '/work'); await openAccount();
 await action().click(); await expect(id('account-action-revoke-others-confirm')).toBeVisible();
 await id('account-action-revoke-others-cancel').click(); await count(0);
 await send(1); await expect(action()).toBeDisabled(); await expect(status()).toContainText('Signing out everywhere else…');
 await roundTrip(); await expect(action()).toBeDisabled(); await count(1);
 await page().clock.runFor(10001); await expect(status()).toContainText('Still waiting for Captain…');
 await answer('ended-2'); await expect(status()).toContainText('2 other active sessions ended.'); await expect(action()).toBeEnabled();
 await roundTrip(); await expect(status()).toContainText('2 other active sessions ended.'); await count(1);
 await noOverflow('session revocation'); await shot('session-revocation');
 await send(2); await expect(status()).not.toContainText('2 other active sessions ended.');
 await answer('ended-0'); await expect(status()).toHaveText('No other active sessions were ended.');
 await send(3); await answer('unknown');
 await expect(status()).toContainText("Captain couldn't confirm whether your other sessions were ended. It's safe to try again.");
 await send(4); await answer('rate-limited'); await expect(action()).toBeDisabled();
 await expect(status()).toContainText('Too many attempts. Try again in 5 seconds.');
 await roundTrip(); await expect(action()).toBeDisabled(); await count(4);
 await page().clock.runFor(4999); await expect(action()).toBeDisabled(); await count(4);
 await page().clock.runFor(2); await expect(action()).toBeEnabled(); await count(4);
 await send(5); await answer('rate-limited-later'); await expect(status()).toContainText('Too many attempts. Try again later.');
 await expect(action()).toBeEnabled();
 await send(6); await answer('refused'); await expect(status()).toContainText("Captain couldn't sign out your other sessions.");
 await send(7); await answer('unauthorised');
 await expect(page().getByRole('heading', { name: 'Signed out', exact: true })).toBeVisible();
 console.log(`PASS ${width}px: session confirmation/cancel, remount-persistent progress/result/wait, slow wording, counts, failures and expiry`);
};
