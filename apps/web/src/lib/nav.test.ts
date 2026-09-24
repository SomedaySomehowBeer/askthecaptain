import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rememberedView, workspaceSection } from './nav.ts';

test('tab restoration keeps local filters and record anchors inside their own section', () => {
 assert.equal(rememberedView('/work?owner=all&tagId=one', '/work'), '/work?owner=all&tagId=one');
 assert.equal(rememberedView('/commitments#task-123', '/work'), '/commitments#task-123');
 assert.equal(rememberedView('/resources/inventory?shopifyOffset=200', '/resources'), '/resources/inventory?shopifyOffset=200');
 assert.equal(workspaceSection('/settings/connections'), '/resources');
 assert.equal(workspaceSection('/settings'), null);
 for (const value of [null, 'https://evil.test', '//evil.test/work', '/\\evil.test', '/\n/evil.test', '/work/../../chat', '/chat', '/work/views'])
  assert.equal(rememberedView(value, '/work'), '/work', String(value));
});
