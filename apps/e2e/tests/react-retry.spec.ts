import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const modules = Object.fromEntries([
  ['next/dist/compiled/react', 'next/dist/compiled/react/cjs/react.production.js'],
  ['next/dist/compiled/react/jsx-runtime', 'next/dist/compiled/react/cjs/react-jsx-runtime.production.js'],
  ['next/dist/compiled/scheduler', 'next/dist/compiled/scheduler/cjs/scheduler.production.js'],
  ['next/dist/compiled/react-dom', 'next/dist/compiled/react-dom/cjs/react-dom.production.js'],
  ['next/dist/compiled/react-dom/client', 'next/dist/compiled/react-dom/cjs/react-dom-client.production.js'],
].map(([id, path]) => [id!, readFileSync(webRequire.resolve(path!), 'utf8')]));
modules.probe = ts.transpileModule(readFileSync(new URL('../../web/src/app/dev/pending/SyncPingProbe.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

/** Exercise Next's actual production renderer, independently of the dev route's production 404. */
test('a synchronous result during rendering retries the suspended revision', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: `
    const sources = ${JSON.stringify(modules)};
    const cache = {};
    function require(id) {
      if (id === 'react') id = 'next/dist/compiled/react';
      if (id === 'react/jsx-runtime') id = 'next/dist/compiled/react/jsx-runtime';
      if (!cache[id]) {
        const module = { exports: {} }; cache[id] = module;
        new Function('module', 'exports', 'require', sources[id])(module, module.exports, require);
      }
      return cache[id].exports;
    }
    require('next/dist/compiled/react-dom/client').createRoot(document.getElementById('root'))
      .render(require('react').createElement(require('probe').SyncPingProbe));
  ` });
  await expect(page.locator('output')).toHaveAttribute('data-count', '0');
  await page.getByRole('button', { name: 'Request revision 1' }).click();
  await expect(page.getByText('Requested revision: 1')).toBeVisible();
  await expect(page.locator('output')).toHaveAttribute('data-count', '1');
  expect(errors).toEqual([]);
});
