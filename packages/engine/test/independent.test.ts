import assert from 'node:assert/strict';
import { test } from 'node:test';
import { each, read, write, defineWorkflow } from '@captain/steps';
import { interpret, Park, Wait } from '../src/index.ts';
const snapshot = (independent: boolean) => ({ definition: defineWorkflow({ key: 'test', version: 1, name: 'test', description: 'test', job: 5, triggers: [{ kind: 'manual' }], parameters: {}, steps: [read('items', { as: 'items' }), each('items', [read('wait'), write('after')], { independent }), write('invoices')] }), enablement: { id: 'e', organisationId: 'o', enabledBy: 'u', parameters: {} }, trigger: {} });
test('independent each catches only a wait; sequential loops, pauses and failures stop', async () => {
 for (const independent of [true, false]) for (const failure of [new Wait(), new Park(), new Error('failure')]) {
  const calls: string[] = [];
  await assert.rejects(interpret(snapshot(independent), async (path, step) => {
   calls.push(step.key + ':' + path); if (step.key === 'items') return [1, 2];
   if (step.key === 'wait' && path.includes('[0]')) throw failure; return null;
  }));
  assert.equal(calls.some(c => c.startsWith('invoices')), independent && failure instanceof Wait);
  assert.equal(calls.some(c => c.includes('[1]')), independent && failure instanceof Wait);
 }
});
