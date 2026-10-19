import test from 'node:test';
import assert from 'node:assert/strict';
import { timeValue, timeText, defaultRange, adjacentFile, adjacentUrl, searchWithSplitting, hitId } from '../src/core.js';
import type { Hit } from '../src/types.js';

test('strict wall time, calendar validation and default range in platform timezone', () => {
  assert.throws(() => timeValue('2026-02-30 01:00:00'));
  assert.throws(() => timeValue('2026-10-19T13:30:00Z'));
  assert.equal(timeText(timeValue('2026-10-19 13:30:00')), '2026-10-19 13:30:00');
  assert.deepEqual(defaultRange('Asia/Shanghai', new Date('2026-10-18T16:10:00Z')), { start: '2026-10-18 23:40:00', end: '2026-10-19 00:10:00' });
});

const makeHit = (instance: string, line: number): Hit => {
  const hit = { id: '', instance, file: '2026-10-19/console.1.log', line, text: 'boom', sourceUrl: 'http://localhost/log', query: { start: '2026-10-19 00:00:00', end: '2026-10-19 00:00:04', keyword: 'boom' } };
  hit.id = hitId(hit); return hit;
};
const range = { start: '2026-10-19 00:00:00', end: '2026-10-19 00:00:04' };
const options = { maxQueries: 32, minSliceSeconds: 1, maxHits: 100 };

test('capped slices bisect without gaps and deduplicate parent hits per instance', async () => {
  const result = await searchWithSplitting(['runner-a', 'runner-b'], 'boom', range, async (instance, slice) => {
    const start = timeValue(slice.start), end = timeValue(slice.end);
    const line = Math.floor((start - timeValue(range.start)) / 1000) + 1;
    return { hits: [makeHit(instance, line)], capped: end - start > 1000 };
  }, options);
  assert.equal(result.completeness, 'complete');
  assert.equal(result.hits.length, 8);
  for (const instance of ['runner-a', 'runner-b']) {
    const leaves = result.slices.filter(slice => slice.instance === instance && slice.capped === false);
    assert.equal(leaves.length, 4);
    assert.equal(leaves[0].start, range.start);
    assert.equal(leaves.at(-1)!.end, range.end);
    for (let i = 1; i < leaves.length; i++) assert.equal(leaves[i - 1].end, leaves[i].start);
  }
});

test('unknown caps and exhausted budgets never report complete', async () => {
  const unknown = await searchWithSplitting(['runner-a'], 'boom', range, async () => ({ hits: [], capped: undefined }), options);
  assert.equal(unknown.completeness, 'unconfirmed');
  const budget = await searchWithSplitting(['runner-a'], 'boom', range, async () => ({ hits: [], capped: true }), { ...options, maxQueries: 1 });
  assert.equal(budget.unresolved.length, 2);
  const minimum = await searchWithSplitting(['runner-a'], 'boom', { start: range.start, end: '2026-10-19 00:00:01' }, async () => ({ hits: [], capped: true }), options);
  assert.match(minimum.unresolved[0].reason, /最小时间片/);
});

test('maxHits cannot silently drop hits or other instances', async () => {
  const result = await searchWithSplitting(['runner-a', 'runner-b'], 'boom', range, async instance => ({ hits: [makeHit(instance, 1), makeHit(instance, 2)], capped: false }), { ...options, maxHits: 1 });
  assert.equal(result.hits.length, 1);
  assert.equal(result.completeness, 'unconfirmed');
  assert.equal(result.unresolved.length, 2);
});

test('numbered neighbors preserve date/instance URL and reject guessing', () => {
  assert.equal(adjacentFile('2026-10-19/console.009.log', 1), '2026-10-19/console.010.log');
  assert.equal(adjacentFile('2026-10-19/console.0.log', -1), undefined);
  assert.equal(adjacentFile('console.log', 1), undefined);
  assert.equal(adjacentUrl('https://example.com/runner-a/2026-10-19/console.9.log', '2026-10-19/console.9.log', '2026-10-19/console.10.log'), 'https://example.com/runner-a/2026-10-19/console.10.log');
  const url = new URL(adjacentUrl('https://example.com/download?instance=runner-a&file=2026-10-19%2Fconsole.9.log', '2026-10-19/console.9.log', '2026-10-19/console.10.log'));
  assert.equal(url.searchParams.get('instance'), 'runner-a');
  assert.equal(url.searchParams.get('file'), '2026-10-19/console.10.log');
  assert.throws(() => adjacentUrl('https://example.com/download?id=abc', 'console.9.log', 'console.10.log'));
});
