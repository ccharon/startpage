'use strict';
// Unit tests for the pure helpers of app.js: node --test web/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../static/app.js');

const bm = (id, title, url, extra) => Object.assign({ id, title, url, tags: [], order: 0 }, extra);
const data = cats => app.renumber({ version: 1, categories: cats });

test('normalizeUrlInput accepts http(s) and rejects other schemes', () => {
  assert.equal(app.normalizeUrlInput('example.org/x'), 'https://example.org/x');
  assert.equal(app.normalizeUrlInput('  http://a.b  '), 'http://a.b/');
  assert.equal(app.normalizeUrlInput('localhost:8080'), 'https://localhost:8080/');
  for (const bad of ['javascript:alert(1)', 'mailto:a@b.c', 'file:///etc/passwd', '', null]) {
    assert.equal(app.normalizeUrlInput(bad), null, String(bad));
  }
});

test('fallbackTarget opens addresses and searches everything else', () => {
  const tpl = 'https://search.example/?q=%s';
  assert.deepEqual(app.fallbackTarget('example.org', tpl), { kind: 'url', url: 'https://example.org/' });
  assert.deepEqual(app.fallbackTarget('intranet:8080', tpl), { kind: 'url', url: 'http://intranet:8080/' });
  assert.deepEqual(app.fallbackTarget('two words', tpl), { kind: 'search', url: 'https://search.example/?q=two%20words' });
  assert.equal(app.isValidSearchTemplate('javascript:%s'), false);
});

test('parseTags trims and removes duplicates case-insensitively', () => {
  assert.deepEqual(app.parseTags(' work, Ticket ,ticket,, x '), ['work', 'Ticket', 'x']);
});

test('normalizeData keeps usage counters only when set', () => {
  const d = app.normalizeData({ version: 1, categories: [{ id: 'c', name: 'n', bookmarks: [
    bm('a', 'A', 'https://a.org', { visits: 2, lastVisit: 100 }),
    bm('b', 'B', 'https://b.org', { visits: 0, lastVisit: -5 })] }] });
  assert.equal(d.categories[0].bookmarks[0].visits, 2);
  assert.equal('visits' in d.categories[0].bookmarks[1], false);
  assert.equal('lastVisit' in d.categories[0].bookmarks[1], false);
});

test('search ranks substring matches above fuzzy ones', () => {
  const idx = app.buildIndex(data([{ id: 'c', name: 'n', bookmarks: [
    bm('1', 'Jenkins Reports', 'https://ci.example'), bm('2', 'Jira', 'https://jira.example')] }]));
  const r = app.search(idx, 'jira');
  assert.equal(r[0].item.bm.id, '2');
  assert.ok(r[0].minTerm >= app.STRONG_MATCH);
  const fuzzy = app.search(idx, 'jra');
  assert.ok(fuzzy.length > 0 && fuzzy[0].minTerm < app.STRONG_MATCH);
});

test('usage bonus reorders equal matches but never lifts a fuzzy match above a substring match', () => {
  const now = Date.now() / 1000;
  const heavy = { visits: 100000, lastVisit: Math.floor(now) };
  assert.ok(app.usageBonus(heavy, now) <= 80);
  assert.ok(app.usageBonus(heavy, now) > app.usageBonus({ visits: 100000, lastVisit: now - 200 * 86400 }, now));
  const idx = app.buildIndex(data([{ id: 'c', name: 'n', bookmarks: [
    bm('1', 'Wiki', 'https://x.example/wiki'), bm('2', 'Jira', 'https://x.example/jira', heavy),
    bm('3', 'Wikipedia', 'https://w.example')] }]));
  assert.equal(app.search(idx, 'x.example')[0].item.bm.id, '2');
  assert.equal(app.search(idx, 'wiki')[0].item.bm.id, '1');
});

test('moveCategory places categories in the same row or in a new row', () => {
  const d = data([{ id: 'a', name: 'A', bookmarks: [] }, { id: 'b', name: 'B', bookmarks: [] }, { id: 'c', name: 'C', bookmarks: [] }]);
  app.moveCategory(d, 'c', 'a', false, true);
  assert.deepEqual(app.categoryRows(d.categories).map(r => r.map(c => c.id)), [['a', 'c'], ['b']]);
  app.moveCategory(d, 'b', 'a', true, false);
  assert.deepEqual(app.categoryRows(d.categories).map(r => r.map(c => c.id)), [['b'], ['a', 'c']]);
});

test('moveBookmark moves between categories', () => {
  const d = data([{ id: 'a', name: 'A', bookmarks: [bm('1', 'One', 'https://1.org')] }, { id: 'b', name: 'B', bookmarks: [bm('2', 'Two', 'https://2.org')] }]);
  assert.ok(app.moveBookmark(d, 'a', '1', 'b', '2', true));
  assert.deepEqual(d.categories[1].bookmarks.map(b => b.id), ['1', '2']);
  assert.equal(d.categories[0].bookmarks.length, 0);
});

test('parseOwnJson skips unsafe URLs and applyImport merges without duplicates', () => {
  const imported = app.parseOwnJson(JSON.stringify({ categories: [{ name: 'Tools', bookmarks: [
    { title: 'Jira', url: 'https://jira.example' }, { title: 'Bad', url: 'javascript:alert(1)' }] }] }));
  assert.equal(imported.skipped, 1);
  const d = data([{ id: 'c', name: 'tools', bookmarks: [bm('1', 'Jira', 'https://jira.example/')] }]);
  const stats = app.applyImport(d, imported, 'merge');
  assert.deepEqual(stats, { added: 0, duplicates: 1, newCategories: 0 });
  assert.throws(() => app.parseOwnJson('{"x":1}'), /categories/);
});

test('normalizeData keeps a description only when set', () => {
  const d = app.normalizeData({ version: 1, categories: [{ id: 'c', name: 'n', bookmarks: [
    bm('a', 'A', 'https://a.org', { description: 'Team board' }), bm('b', 'B', 'https://b.org', { description: 7 })] }] });
  assert.equal(d.categories[0].bookmarks[0].description, 'Team board');
  assert.equal('description' in d.categories[0].bookmarks[1], false);
});

test('search finds description words below title, tag and URL matches', () => {
  const idx = app.buildIndex(data([{ id: 'c', name: 'n', bookmarks: [
    bm('1', 'Board', 'https://a.example', { description: 'Sprint planning for the infra team' }),
    bm('2', 'Infra', 'https://b.example')] }]));
  const r = app.search(idx, 'infra');
  assert.deepEqual(r.map(x => x.item.bm.id), ['2', '1']);
  const only = app.search(idx, 'sprint');
  assert.equal(only.length, 1);
  assert.ok(only[0].minTerm < app.STRONG_MATCH && only[0].minTerm > 300);
  assert.equal(app.search(idx, 'sprnt').length, 0);
});

test('cleanDescription keeps line breaks and trims whitespace', () => {
  assert.equal(app.cleanDescription('  one \t two \r\n\r\n\r\n  three  '), 'one two\n\nthree');
  assert.equal(app.cleanDescription('x'.repeat(2100)).length, 2000);
  assert.equal(app.cleanDescription(null), '');
});

test('parseOwnJson and applyImport carry descriptions', () => {
  const imported = app.parseOwnJson(JSON.stringify({ categories: [{ name: 'Tools', bookmarks: [
    { title: 'Jira', url: 'https://jira.example', description: ' Tickets ' }, { title: 'Wiki', url: 'https://wiki.example' }] }] }));
  const d = data([]);
  app.applyImport(d, imported, 'merge');
  assert.equal(d.categories[0].bookmarks[0].description, 'Tickets');
  assert.equal('description' in d.categories[0].bookmarks[1], false);
});

test('tipPosition flips above the pointer and stays inside the viewport', () => {
  assert.deepEqual(app.tipPosition(100, 100, 200, 50, 1000, 800), { left: 112, top: 116 });
  assert.deepEqual(app.tipPosition(950, 780, 200, 50, 1000, 800), { left: 796, top: 714 });
  assert.deepEqual(app.tipPosition(10, 10, 2000, 50, 1000, 800), { left: 4, top: 26 });
});
