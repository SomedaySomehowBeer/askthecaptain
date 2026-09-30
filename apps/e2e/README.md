# Browser and deployment checks

`tests/smoke.spec.ts` is a manual deployment smoke check: API `/healthz` and `/readyz`,
then the Expo HTML root at `E2E_WEB_URL/`. Set both `E2E_API_URL` and `E2E_WEB_URL`
explicitly and run `pnpm --filter @captain/e2e e2e`. The origins may be the same.
It does not sign in or verify readiness of a real account. The disabled deploy
workflow retains only API deployments and does not run this smoke suite.

`node apps/e2e/scripts/mobile-shell-ci.mjs` serves fresh production and harness
exports from `apps/mobile/dist/web` and `apps/mobile/dist-harness`. The retained
`mobile-shell-*` scripts check cookie sessions, account controls, equipment and
layout at phone and desktop widths using synthetic API answers. See
[the mobile workflow](../../.github/workflows/mobile.yml) for exports and boundary checks.

R1c removed the Next.js page suites and their fixture servers. The former native
sign-in browser handoff proof has no replacement here. Native protocol tests and
JavaScript exports remain; neither proves native sign-in on a device. Real Google
sign-in, hosted passkey step-up and Web Push registration remain release checks.
