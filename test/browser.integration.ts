import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { BrowserBackend } from '../src/browser.js';
import { LogService } from '../src/service.js';

const html = `<!doctype html><meta charset="utf-8">
<span class="el-tree-node__label" onclick="document.querySelector('#form').hidden=false">runner-a</span>
<span class="el-tree-node__label" onclick="document.querySelector('#form').hidden=false">runner-b</span>
<div id="form" hidden>
<div class="el-date-editor"><input class="el-range-input"><input class="el-range-input"></div>
<input placeholder="搜索关键字"><button onclick="search()">搜索</button>
<div class="el-table__body-wrapper"><table><tbody></tbody></table></div>
<span class="el-table__empty-text" style="display:none">暂无数据</span>
</div>
<div class="log-preview-drawer" style="display:none"><div class="view-lines">visible preview only</div><button class="el-drawer__close-btn" onclick="this.parentNode.style.display='none'">close</button></div>
<script>
async function search() {
 const response=await fetch('/query?keyword='+encodeURIComponent(document.querySelector('[placeholder]').value));
 const data=await response.json();
 document.querySelector('.el-table__empty-text').style.display=data.empty?'block':'none';
 document.querySelector('tbody').innerHTML=data.empty?'':'<tr><td>2026-10-19/console.1.log</td><td>1</td><td>12:00:01.000 ERROR boom</td><td><button onclick="preview()">预览</button><a href="/files/runner-a/2026-10-19/console.1.log" target="_blank">下载</a></td></tr>';
}
function preview(){document.querySelector('.log-preview-drawer').style.display='block'}
</script>`;

test('real Chromium: iframe, delayed query, preview, Basic auth, attachment and adjacent inline file', { timeout: 90000 }, async () => {
  const downloads: string[] = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<iframe src="/app" width="1400" height="900"></iframe>'); }
    else if (request.url === '/app') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); }
    else if (request.url?.startsWith('/query')) {
      setTimeout(() => {
        if (request.url?.includes('fail')) { response.writeHead(500); response.end('failed'); return; }
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ empty: request.url?.includes('empty') }));
      }, 250);
    } else if (request.url?.startsWith('/files/')) {
      if (request.headers.authorization !== 'Basic ' + Buffer.from('user:secret').toString('base64')) { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }); response.end('authentication required'); return; }
      downloads.push(request.url);
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      if (request.url.endsWith('console.1.log')) { response.setHeader('Content-Disposition', 'attachment; filename="console.1.log"'); response.end('12:00:01.000 ERROR boom\n at stack\n'); }
      else if (request.url.endsWith('console.0.log')) response.end('12:00:00.000 prior\nprevious stack\n');
      else { response.setHeader('Content-Disposition', 'attachment; filename="console.2.log"'); response.end(' next stack\n12:00:02.000 done\n'); }
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bxure-browser-'));
  const original = [process.env.BXURE_DOWNLOAD_USERNAME, process.env.BXURE_DOWNLOAD_PASSWORD, process.env.BXURE_DOWNLOAD_ORIGIN];
  process.env.BXURE_DOWNLOAD_USERNAME = 'user'; process.env.BXURE_DOWNLOAD_PASSWORD = 'secret'; process.env.BXURE_DOWNLOAD_ORIGIN = url;
  const backend = new BrowserBackend(configSchema.parse({ url, dataDir, headless: true, resultLimit: 20, timeoutMs: 10000 }));
  const service = new LogService(backend, configSchema.parse({ url, dataDir, headless: true, resultLimit: 20 }));
  try {
    assert.equal((await backend.open()).ready, true);
    assert.deepEqual(await backend.listInstances(), ['runner-a', 'runner-b']);
    const result = await service.search({ keyword: 'boom', instances: ['runner-a'], start: '2026-10-19 12:00:00', end: '2026-10-19 12:01:00' });
    assert.equal(result.hits.length, 1);
    assert.equal((await service.preview(result.hits[0].id)).text, 'visible preview only');
    const context = await service.context(result.hits[0].id, { before: 2, after: 3, adjacentFiles: 1, maxChars: 1000 });
    assert.equal(context.segments.length, 3);
    assert.equal(context.warnings.length, 0);
    assert.equal(downloads.length, 3);
    const empty = await service.search({ keyword: 'empty', instances: ['runner-a'] });
    assert.equal(empty.hits.length, 0);
    await assert.rejects(service.search({ keyword: 'fail', instances: ['runner-a'] }), /网络请求失败/);
  } finally {
    await backend.close();
    const keys = ['BXURE_DOWNLOAD_USERNAME', 'BXURE_DOWNLOAD_PASSWORD', 'BXURE_DOWNLOAD_ORIGIN'];
    keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
