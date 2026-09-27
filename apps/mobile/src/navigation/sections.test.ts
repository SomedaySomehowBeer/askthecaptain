import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkableRoutes, linkTarget } from '../lib/links.ts';
import { sections } from './sections.ts';

test('exactly three sections, Work, Chat and Resources, in that order; Work opens at My work', () => {
	assert.deepEqual(sections.map((s) => s.label), ['Work', 'Chat', 'Resources']);
	const work = sections[0]!;
	assert.equal(work.href, '/work');
	assert.deepEqual(work.groups[0]!.rows[0], { label: 'My work', detail: 'Assigned to you, across all tags', href: '/work' });
});

test('each section has a grouped view list one page to its left, reachable by link, with an accessible name', () => {
	for (const section of sections) {
		assert.equal(section.viewsHref, `${section.href}/views`);
		assert.equal(linkTarget(section.viewsHref), section.viewsHref);
		assert.equal(linkTarget(section.href), section.href);
		assert.ok(section.viewsLabel.length > 0 && section.groups.length > 0);
		for (const group of section.groups) assert.ok(group.title.length > 0 && group.rows.length > 0, group.title);
	}
});

test('a view row opens only a route that exists and is linkable; everything else is shown as unavailable', () => {
	const available = sections.flatMap((s) => s.groups.flatMap((g) => g.rows)).filter((r) => r.href !== null);
	for (const row of available) assert.ok(linkableRoutes.has(row.href!), row.label);
	const unavailable = sections.flatMap((s) => s.groups.flatMap((g) => g.rows)).filter((r) => r.href === null);
	for (const row of unavailable) assert.match(row.detail, /not available/i, row.label);
	assert.deepEqual(sections.map((s) => s.groups[0]!.rows[0]!.href), ['/work', '/chat', '/resources'], 'each section’s first row is its default view');
});
