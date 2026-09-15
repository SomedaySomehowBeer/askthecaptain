# Next 15.5.25: preserve synchronous React retries

`next@15.5.25.patch` backports the retry bookkeeping from
[React #36134](https://github.com/react/react/pull/36134)
([c0d218f](https://github.com/react/react/commit/c0d218f0f3e02ed581f74096e56baa947213135d))
to Next's bundled React DOM client and profiling renderers, in development and
production. A promise callback during a suspended render must record its lane
for a retry, even when restarting the render immediately would be unsafe.

The App Router uses these bundled renderers; changing the app's `react-dom`
package version does not change them. No experimental renderer is enabled here.

pnpm applies this version-specific patch through `pnpm-workspace.yaml`; the
lockfile records its hash. Remove it only when the replacement Next renderer
includes the fix and `apps/e2e/tests/react-retry.spec.ts` passes without the patch.
That behavioral regression runs in CI using Next's actual production renderer.
See [the investigation](../docs/investigations/11-pending.md) for the captured
failure and production-browser comparison.
