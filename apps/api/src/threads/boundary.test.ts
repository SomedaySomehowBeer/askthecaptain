import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The private-thread boundary (threads contract §9; D25): the tables that hold private messages, participants and their
// audit are referenced only from apps/api/src/threads/, from migrations, from the Drizzle mirror of the schema and from
// tests, so no other module can read private messages. R4 builds its inference boundary on this. A pure file scan.
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const tables = /\b(thread_messages|thread_participants|chat_audit_events)\b/;
const scanned = /\.(ts|tsx|js|mjs|cjs|sql)$/;
const skipped = new Set(['node_modules', 'dist', '.expo', '.turbo', 'coverage', 'playwright-report', 'test-results']);
const allowed = (path: string) => path.startsWith('apps/api/src/threads/') || path.startsWith('packages/db/migrations/') || path.startsWith('packages/db/test/')
 || path === 'packages/db/src/threads-schema.ts' || /\.test\.tsx?$/.test(path);

async function* files(dir: string): AsyncGenerator<string> {
 for (const entry of await readdir(dir, { withFileTypes: true })) {
  if (skipped.has(entry.name) || entry.name.startsWith('.')) continue;
  const path = join(dir, entry.name);
  if (entry.isDirectory()) yield* files(path);
  else if (scanned.test(entry.name)) yield path;
 }
}

test('thread_messages, thread_participants and chat_audit_events are referenced only from apps/api/src/threads/', async () => {
 const referencing: string[] = [];
 for (const top of ['apps', 'packages']) for await (const path of files(join(root, top)))
  if (tables.test(await readFile(path, 'utf8'))) referencing.push(relative(root, path));
 assert.deepEqual(referencing.filter(path => !allowed(path)), [], 'only the threads module may name the private tables');
 // The scan really sees the module and the migration, so an empty result above means something.
 for (const expected of ['apps/api/src/threads/service.ts', 'apps/api/src/threads/tags.ts', 'packages/db/migrations/0046_threads.sql'])
  assert.ok(referencing.includes(expected), expected);
});
