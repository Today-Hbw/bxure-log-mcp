import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { LogService, continuity } from '../src/service.js';
import { hitId } from '../src/core.js';
import type { Hit, LogBackend } from '../src/types.js';

test('cross-file context retains real lines, instance and boundary status', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bxure-test-'));
  const hit: Hit = { id: '', instance: 'runner-a', file: '2026-10-19/console.1.log', line: 1, text: '12:00:01.000 ERROR boom', sourceUrl: 'http://localhost/log', query: { keyword: 'boom', start: '2026-10-19 12:00:00', end: '2026-10-19 12:01:00' } };
  hit.id = hitId(hit);
  const files = new Map([
    ['2026-10-19/console.0.log', '12:00:00.000 prior\nprior stack\n'],
    ['2026-10-19/console.1.log', '12:00:01.000 ERROR boom\n at stack\n'],
    ['2026-10-19/console.2.log', ' more stack\n12:00:02.000 completed\n'],
  ]);
  const requests: string[] = [];
  const backend: LogBackend = {
    open: async () => ({ url: '', ready: true, message: '' }),
    listInstances: async () => ['runner-a', 'runner-b'],
    search: async () => ({ hits: [hit], capped: false }),
    preview: async () => 'partial',
    download: async h => { requests.push(h.instance + '/' + h.file); h.downloadUrl = 'http://localhost/file'; return Buffer.from(files.get(h.file)!); },
    downloadAdjacent: async (h, file) => { requests.push(h.instance + '/' + file); return Buffer.from(files.get(file)!); },
    close: async () => {},
  };
  try {
    const service = new LogService(backend, configSchema.parse({ dataDir }));
    await assert.rejects(service.search({ keyword: 'boom', start: hit.query.start }), /同时提供/);
    await assert.rejects(service.search({ keyword: 'boom', instances: ['unknown'] }), /实例/);
    const result = await service.search({ keyword: 'boom', instances: ['runner-a'], start: hit.query.start, end: hit.query.end });
    assert.equal('downloadUrl' in result.hits[0], false);
    const context = await service.context(hit.id, { before: 2, after: 3, adjacentFiles: 1, maxChars: 1000 });
    assert.deepEqual(context.segments.map(segment => segment.file), [...files.keys()]);
    assert.deepEqual(context.segments.map(segment => [segment.startLine, segment.endLine]), [[1, 2], [1, 2], [1, 2]]);
    assert.ok(requests.every(request => request.startsWith('runner-a/')));
    assert.ok(context.boundaries.every(boundary => boundary.status === 'chronological'));
    assert.equal(context.warnings.length, 0);
    assert.equal((await service.find(hit.id, 'stack')).totalMatches, 1);
    await service.download(hit.id);
    assert.equal(requests.length, 3, 'same process reuses downloaded files');
    assert.equal((await service.preview(hit.id)).complete, false);
    const limited = await service.context(hit.id, { before: 2, after: 3, adjacentFiles: 1, maxChars: 5 });
    assert.equal(limited.truncated, true);
    assert.equal(limited.segments[0].relation, 'hit');
    assert.equal(limited.segments[0].lines[0].line, hit.line);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('continuity does not certify missing, reversed or distant timestamps', () => {
  assert.equal(continuity(['stack'], ['more stack']).status, 'unverified');
  assert.equal(continuity(['12:01:00.000 end'], ['12:00:00.000 start']).status, 'unverified');
  assert.equal(continuity(['12:00:00.000 end'], ['12:30:00.000 start']).status, 'unverified');
});
