import { loadConfig } from '../src/config.js';
import { BrowserBackend } from '../src/browser.js';
import { LogService } from '../src/service.js';
import { LogError } from '../src/types.js';

const config = await loadConfig();
const backend = new BrowserBackend(config);
const service = new LogService(backend, config);
try {
  const opened = await backend.open();
  console.log('open', opened);
  if (!opened.ready) throw new LogError('LOGIN_REQUIRED', '请先完成专用浏览器初始化');
  const instances = await backend.listInstances();
  console.log('instance count', instances.length);
  const result = await service.search({ keyword: process.env.BXURE_SMOKE_KEYWORD ?? '城市', start: process.env.BXURE_SMOKE_START ?? '2026-10-19 13:30:00', end: process.env.BXURE_SMOKE_END ?? '2026-10-19 13:35:00', maxHits: 5 });
  console.log('search', { count: result.hits.length, queries: result.queries, completeness: result.completeness, files: result.hits.map(hit => ({ file: hit.file, line: hit.line })) });
  if (!result.hits.length) throw new LogError('SMOKE_NO_HIT', '指定检索范围没有命中，无法验证预览和下载，请调整 smoke 时间或关键字');
  if (result.hits[0]) {
    const preview = await service.preview(result.hits[0].id);
    console.log('preview', { chars: preview.text.length, complete: preview.complete });
    if (process.env.BXURE_SMOKE_DOWNLOAD === '1') {
      const file = await service.download(result.hits[0].id);
      console.log('download', { lineCount: file.lineCount });
      for (const line of [1, file.lineCount]) {
        const context = await service.context(result.hits[0].id, { line, before: 2, after: 2, adjacentFiles: 1, maxChars: 5000 });
        console.log('context', { line, segments: context.segments.map(segment => ({ file: segment.file, startLine: segment.startLine, endLine: segment.endLine })), boundaries: context.boundaries, warnings: context.warnings });
        if (context.segments.length < 2 || context.warnings.length) throw new LogError('CONTEXT_VERIFICATION_FAILED', '相邻文件验证未完成，请检查上述摘要');
      }
    }
  }
} catch (error) {
  if (error instanceof LogError) console.error({ code: error.code, message: error.message });
  else console.error('Live verification failed. Check browser adapter and page state.');
  process.exitCode = 1;
} finally { await backend.close(); }
