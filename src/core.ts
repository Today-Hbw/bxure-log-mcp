import { createHash } from 'node:crypto';
import type { Hit, TimeRange, SearchPage } from './types.js';
import { LogError } from './types.js';

// Page values are local wall-clock seconds, with an exclusive end.
export function timeValue(text: string): number {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    throw new LogError('INVALID_TIME', '时间格式必须为 YYYY-MM-DD HH:mm:ss（平台时区）');
  }
  const value = Date.parse(text.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(value) || timeText(value) !== text) throw new LogError('INVALID_TIME', '无效日期');
  return value;
}
export function timeText(value: number): string { return new Date(value).toISOString().slice(0, 19).replace('T', ' '); }
export function defaultRange(timezone: string, now = new Date()): TimeRange {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const end = `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  return { start: timeText(timeValue(end) - 30 * 60_000), end };
}
export function validateRange(range: TimeRange): void {
  if (timeValue(range.end) <= timeValue(range.start)) throw new LogError('INVALID_RANGE', '结束时间必须大于开始时间');
}
export function hitId(hit: Pick<Hit, 'instance' | 'file' | 'line' | 'text'>): string {
  return createHash('sha256').update(JSON.stringify([hit.instance, hit.file, hit.line, hit.text])).digest('hex').slice(0, 24);
}

export async function searchWithSplitting(
  instances: string[], keyword: string, range: TimeRange,
  search: (instance: string, range: TimeRange) => Promise<SearchPage>,
  options: { maxQueries: number; minSliceSeconds: number; maxHits: number },
) {
  validateRange(range);
  const pending = instances.map(instance => ({ instance, ...range }));
  const hits = new Map<string, Hit>();
  const unresolved: Array<TimeRange & { instance: string; reason: string }> = [];
  const slices: Array<TimeRange & { instance: string; hits: number; capped: boolean | undefined }> = [];
  let queries = 0;
  let omitted = false;
  while (pending.length && queries < options.maxQueries) {
    const slice = pending.shift()!;
    const page = await search(slice.instance, slice);
    queries++;
    slices.push({ ...slice, hits: page.hits.length, capped: page.capped });
    for (const hit of page.hits) {
      if (hits.has(hit.id)) continue;
      if (hits.size >= options.maxHits) { omitted = true; continue; }
      hits.set(hit.id, hit);
    }
    if (omitted) { unresolved.push({ ...slice, reason: '返回命中条数已达 maxHits' }); break; }
    if (page.capped === undefined) {
      unresolved.push({ ...slice, reason: '平台结果上限未知；少量结果也无法保证完整，请配置 resultLimit 或 limitIndicator' });
    } else if (page.capped) {
      const start = timeValue(slice.start), end = timeValue(slice.end);
      if (end - start <= options.minSliceSeconds * 1000) {
        unresolved.push({ ...slice, reason: '最小时间片内仍达到结果上限' });
      } else {
        const mid = start + Math.floor((end - start) / 2000) * 1000;
        pending.push({ instance: slice.instance, start: slice.start, end: timeText(mid) }, { instance: slice.instance, start: timeText(mid), end: slice.end });
      }
    }
  }
  unresolved.push(...pending.map(slice => ({ ...slice, reason: omitted ? '返回命中条数已达 maxHits' : '已达 maxQueries，尚未检索' })));
  return { keyword, range, instances, endExclusive: true, hits: [...hits.values()], queries, slices, completeness: unresolved.length ? 'unconfirmed' : 'complete', unresolved };
}

export function adjacentFile(file: string, offset: number): string | undefined {
  const match = /^(.*?)(\d+)(\.log)$/.exec(file);
  if (!match) return undefined;
  const next = Number(match[2]) + offset;
  if (!Number.isSafeInteger(next) || next < 0) return undefined;
  const digits = match[2].startsWith('0') ? String(next).padStart(match[2].length, '0') : String(next);
  return `${match[1]}${digits}${match[3]}`;
}

// Only change the exact discovered file component; keep host and instance intact.
export function adjacentUrl(original: string, oldFile: string, newFile: string): string {
  const url = new URL(original);
  let changed = false;
  const replace = (value: string) => {
    if (value === oldFile || value.endsWith('/' + oldFile)) { changed = true; return value.slice(0, -oldFile.length) + newFile; }
    return value;
  };
  const pathname = replace(decodeURIComponent(url.pathname));
  if (changed) url.pathname = pathname.split('/').map(encodeURIComponent).join('/');
  for (const [key, value] of url.searchParams) url.searchParams.set(key, replace(value));
  if (!changed) throw new LogError('ADJACENT_URL_UNKNOWN', '下载地址中未识别出完整文件名，需按实际 URL 规则适配，不能猜测其他实例');
  return url.href;
}

export function splitLines(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
