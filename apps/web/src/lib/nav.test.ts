import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rememberedView, workspaceSection } from './nav.ts';

test('tab restoration keeps local filters and record anchors inside their own section', () => {
 assert.equal(rememberedView('/work?owner=all&tagId=one', '/work'), '/work?owner=all&tagId=one');
 assert.equal(rememberedView('/work/tasks/123', '/work'), '/work/tasks/123');
 assert.equal(rememberedView('/resources/inventory?shopifyOffset=200', '/resources'), '/resources/inventory?shopifyOffset=200');
 assert.equal(workspaceSection('/settings/connections'), '/resources');
 assert.equal(workspaceSection('/settings'), null);
 assert.equal(workspaceSection('/settings/contacts/0190c0de-0000-7000-8000-000000000000'), '/resources');
 for (const value of [null, 'https://evil.test', '//evil.test/work', '/\\evil.test', '/\n/evil.test', '/work/../../chat', '/chat', '/work/views'])
  assert.equal(rememberedView(value, '/work'), '/work', String(value));
});

test('retired assistant pages belong to no section and are never restored by a tab', () => {
 for (const path of ['/commitments', '/commitments#task-123', '/today', '/inbox', '/inbox/0190c0de-0000-7000-8000-000000000000', '/inbox/contacts/x', '/calendar', '/notes', '/notes/x']) {
  assert.equal(workspaceSection(path), null, path);
  assert.equal(rememberedView(path, '/work'), '/work', path);
  assert.equal(rememberedView(path, '/resources'), '/resources', path);
 }
 assert.equal(workspaceSection('/todays'), null);
});
