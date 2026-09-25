import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

// #133: the personal assistant's pages remain only as retired states. Nothing else in the web may
// link to them, revalidate them or call the retired question action.
const root = new URL('..', import.meta.url).pathname;
const retired = /["'`]\/(today|inbox|calendar|notes|commitments)(?=[/"'`?#$])/;
const owners = /^app\/(today|inbox|calendar|notes|commitments)\//;

function* sources(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* sources(path);
		else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) yield path;
	}
}

test('no page, action or component links to a retired assistant destination', () => {
	const offenders: string[] = [];
	for (const path of sources(root)) {
		const file = relative(root, path);
		if (owners.test(file)) continue;
		readFileSync(path, 'utf8').split('\n').forEach((line, index) => { if (retired.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`); });
	}
	assert.deepEqual(offenders, []);
});
