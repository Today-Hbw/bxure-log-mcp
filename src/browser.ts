import { chromium, type BrowserContext, type Page, type Frame, type Request, type Response, type Download, type Locator } from 'playwright';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { adjacentUrl, hitId } from './core.js';
import { LogError, type Hit, type LogBackend, type TimeRange } from './types.js';

export class BrowserBackend implements LogBackend {
  private context?: BrowserContext;
  private page?: Page;
  constructor(private config: Config) {}

  private async start(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const profileDir = path.join(this.config.dataDir, 'profiles', this.config.profile);
    await mkdir(profileDir, { recursive: true });
    const username = process.env.BXURE_DOWNLOAD_USERNAME;
    const password = process.env.BXURE_DOWNLOAD_PASSWORD;
    const origin = process.env.BXURE_DOWNLOAD_ORIGIN;
    if ((username || password) && !(username && password && origin)) {
      throw new LogError('AUTH_CONFIG', '下载认证需同时设置 BXURE_DOWNLOAD_USERNAME、BXURE_DOWNLOAD_PASSWORD、BXURE_DOWNLOAD_ORIGIN');
    }
    try {
      this.context = await chromium.launchPersistentContext(profileDir, {
        headless: this.config.headless,
        ...(this.config.browserChannel === 'chromium' ? {} : { channel: this.config.browserChannel }),
        acceptDownloads: true,
        viewport: { width: 1440, height: 960 },
        ...(username && password && origin ? { httpCredentials: { username, password, origin: new URL(origin).origin } } : {}),
      });
    } catch {
      throw new LogError('BROWSER_START_FAILED', '无法启动专用浏览器。请运行 npx playwright install chromium，并确认同一 profile 未被其他进程占用');
    }
    this.context.setDefaultTimeout(this.config.timeoutMs);
    this.context.on('close', () => { this.page = undefined; this.context = undefined; });
    // Import once per dedicated profile, including projects stored in IndexedDB.
    try {
      const marker = path.join(profileDir, '.bootstrap-imported');
      const imported = await stat(marker).then(() => true, () => false);
      if (!imported) {
        const state = path.join(this.config.dataDir, 'bootstrap.json');
        await stat(state);
        await this.context.setStorageState(state);
        await writeFile(marker, '1');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new LogError('BOOTSTRAP_INVALID', 'bootstrap.json 无法读取，请重新导出浏览器状态');
    }
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.page.goto(this.config.url, { waitUntil: 'domcontentloaded' });
    return this.page;
  }

  private async findFrame(): Promise<Frame | undefined> {
    const page = await this.start();
    for (const frame of page.frames()) {
      if (await frame.locator(this.config.selectors.instanceItems).first().isVisible().catch(() => false)) return frame;
    }
    return undefined;
  }

  async open() {
    const page = await this.start();
    const deadline = Date.now() + this.config.timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      ready = !!await this.findFrame();
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return { url: page.url(), ready, message: ready ? '日志页已就绪；首次使用前请调用 list_instances' : '请在打开的浏览器中手动登录、创建或导入项目，然后回到日志页再次调用 open_log_platform' };
  }

  private async frame(): Promise<Frame> {
    const frame = await this.findFrame();
    if (!frame) throw new LogError('LOGIN_REQUIRED', '未发现实例列表，请先 open_log_platform，在专用浏览器中完成登录及项目初始化');
    return frame;
  }

  async listInstances(): Promise<string[]> {
    const frame = await this.frame();
    const labels = await frame.locator(this.config.selectors.instanceItems).allTextContents();
    return [...new Set(labels.map(value => value.trim()).filter(value => /^(runner|gateway|configurator)(?:-|$)/.test(value)))];
  }

  private async select(instance: string): Promise<Frame> {
    const frame = await this.frame();
    const items = frame.locator(this.config.selectors.instanceItems);
    let found: Locator | undefined;
    for (let i = 0; i < await items.count(); i++) {
      if ((await items.nth(i).textContent())?.trim() === instance) { found = items.nth(i); break; }
    }
    if (!found) throw new LogError('INSTANCE_NOT_FOUND', '实例不存在，请重新调用 list_instances');
    await found.click();
    await frame.locator(this.config.selectors.keyword).waitFor({ state: 'visible' });
    return frame;
  }

  private async submit(frame: Frame): Promise<void> {
    const page = this.page!;
    const pending = new Set<Request>();
    let observed = false, lastChange = Date.now(), failure = false;
    const request = (req: Request) => {
      if (req.frame() === frame && ['xhr', 'fetch'].includes(req.resourceType())) { observed = true; pending.add(req); lastChange = Date.now(); }
    };
    const finished = (req: Request) => { if (pending.delete(req)) lastChange = Date.now(); };
    const failed = (req: Request) => { if (pending.has(req)) failure = true; finished(req); };
    const response = (res: Response) => { if (pending.has(res.request()) && res.status() >= 400) failure = true; };
    page.on('request', request); page.on('requestfinished', finished); page.on('requestfailed', failed); page.on('response', response);
    try {
      await frame.locator(this.config.selectors.searchButton).click();
      const deadline = Date.now() + this.config.timeoutMs;
      while (Date.now() < deadline) {
        if (observed && pending.size === 0 && Date.now() - lastChange >= 300) {
          if (failure) throw new LogError('QUERY_FAILED', '日志查询网络请求失败；不能将旧表格当作本次结果');
          if (this.config.selectors.loading) await frame.locator(this.config.selectors.loading).waitFor({ state: 'hidden' });
          const error = frame.locator('.el-message--error:visible, .el-notification--error:visible');
          if (await error.count()) throw new LogError('QUERY_FAILED', '页面提示查询失败，请在浏览器中检查');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new LogError('QUERY_TIMEOUT', '未确认查询请求完成。请检查页面、选择器或登录状态，不能返回旧结果');
    } finally {
      page.off('request', request); page.off('requestfinished', finished); page.off('requestfailed', failed); page.off('response', response);
    }
  }

  async search(instance: string, keyword: string, range: TimeRange) {
    const frame = await this.select(instance);
    const s = this.config.selectors;
    if (await frame.locator(s.startTime).getAttribute('readonly') !== null) {
      await frame.locator(s.startTime).click();
      // Two passes let the widget accept a range wholly before/after its old range.
      for (let pass = 0; pass < 2; pass++) {
        for (const [selector, value] of [
          [s.pickerEndDate, range.end.slice(0, 10)], [s.pickerEndTime, range.end.slice(11)],
          [s.pickerStartDate, range.start.slice(0, 10)], [s.pickerStartTime, range.start.slice(11)],
        ]) {
          const input = frame.locator(selector);
          await input.fill(value);
          await input.press('Tab');
        }
      }
      await frame.locator(s.pickerConfirm).click();
    } else {
      for (const [selector, value] of [[s.startTime, range.start], [s.endTime, range.end]]) {
        await frame.locator(selector).fill(value);
        await frame.locator(selector).press('Tab');
      }
    }
    for (const [selector, value] of [[s.startTime, range.start], [s.endTime, range.end]]) {
      if (await frame.locator(selector).inputValue() !== value) throw new LogError('FORM_VALUE_REJECTED', '页面未接受时间范围，请检查日期选择器');
    }
    for (const [selector, value] of [[s.keyword, keyword]]) {
      const input = frame.locator(selector);
      await input.fill(value);
      await input.press('Tab');
      if (await input.inputValue() !== value) throw new LogError('FORM_VALUE_REJECTED', '页面未接受查询条件，请检查时间格式或选择器');
    }
    await this.submit(frame);
    const rows = frame.locator(s.resultRows);
    const hits: Hit[] = [];
    if (await rows.count() === 0 && !await frame.locator(s.empty).isVisible()) {
      throw new LogError('ROW_PARSE_FAILED', '既未发现结果行，也未发现空结果提示；请检查页面适配，不能认定无日志');
    }
    for (let i = 0; i < await rows.count(); i++) {
      const cells = rows.nth(i).locator(s.cells);
      if (await cells.count() < 3) throw new LogError('ROW_PARSE_FAILED', '表格列与配置不匹配');
      const file = (await cells.nth(0).innerText()).trim();
      const line = Number((await cells.nth(1).innerText()).trim());
      const text = await cells.nth(2).innerText();
      if (!file.endsWith('.log') || !Number.isInteger(line) || line < 1) throw new LogError('ROW_PARSE_FAILED', '无法提取文件名或行号，请检查页面适配');
      const button = rows.nth(i).locator(s.downloadButton).first();
      const href = await button.getAttribute('href');
      const hit: Hit = { id: '', instance, file, line, text, sourceUrl: this.page!.url(), query: { ...range, keyword } };
      if (href && !href.startsWith('javascript:') && href !== '#') hit.downloadUrl = new URL(href, frame.url()).href;
      hit.id = hitId(hit);
      hits.push(hit);
    }
    let capped: boolean | undefined = this.config.resultLimit === null ? undefined : hits.length >= this.config.resultLimit;
    if (s.limitIndicator) capped = capped === true || await frame.locator(s.limitIndicator).isVisible();
    return { hits, capped };
  }

  private async row(hit: Hit): Promise<Locator> {
    await this.search(hit.instance, hit.query.keyword, hit.query);
    const frame = await this.frame();
    const rows = frame.locator(this.config.selectors.resultRows);
    for (let i = 0; i < await rows.count(); i++) {
      const cells = rows.nth(i).locator(this.config.selectors.cells);
      if ((await cells.nth(0).innerText()).trim() === hit.file && Number((await cells.nth(1).innerText()).trim()) === hit.line) return rows.nth(i);
    }
    throw new LogError('HIT_EXPIRED', '重新查询未找到该命中；可能已轮转或原查询受上限影响，请缩小时间范围重新搜索');
  }

  async preview(hit: Hit): Promise<string> {
    const row = await this.row(hit);
    const frame = await this.frame();
    await row.locator(this.config.selectors.previewButton).first().click();
    const content = frame.locator(this.config.selectors.previewContent).first();
    await content.waitFor({ state: 'visible' });
    if (this.config.selectors.loading) await frame.locator(this.config.selectors.loading).waitFor({ state: 'hidden' });
    try { return await content.evaluate(el => el instanceof HTMLTextAreaElement ? el.value : (el as HTMLElement).innerText); }
    finally { await frame.locator(this.config.selectors.previewClose).click(); }
  }

  private async collectDownload(action: () => Promise<unknown>): Promise<{ body: Buffer; url: string }> {
    const context = this.context!;
    const initialPages = new Set(context.pages());
    const attached = new Set<Page>();
    let timer: NodeJS.Timeout;
    let settle!: (result: { body: Buffer; url: string }) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<{ body: Buffer; url: string }>((resolve, fail) => { settle = resolve; reject = fail; });
    const download = async (item: Download) => {
      try {
        const file = await item.path();
        if (!file) throw new LogError('DOWNLOAD_FAILED', '浏览器下载失败');
        if ((await stat(file)).size > this.config.maxFileBytes) throw new LogError('FILE_TOO_LARGE', '文件超过 maxFileBytes');
        settle({ body: await readFile(file), url: item.url() });
      } catch (error) { reject(error); }
    };
    const attach = (page: Page) => { attached.add(page); page.on('download', download); };
    for (const page of context.pages()) attach(page);
    context.on('page', attach);
    const response = async (res: Response) => {
      if (!res.request().isNavigationRequest()) return;
      const type = res.headers()['content-type'] ?? '';
      if (res.status() === 401 || res.status() === 403) { reject(new LogError('DOWNLOAD_AUTH_REQUIRED', `下载站点 ${new URL(res.url()).origin} 拒绝认证，请设置本地下载认证环境变量并重启 MCP`)); return; }
      if (!/text\/plain|application\/octet-stream/.test(type) || res.headers()['content-disposition']?.includes('attachment')) return;
      try {
        if (!res.ok()) throw new LogError('DOWNLOAD_FAILED', '下载响应失败');
        if (Number(res.headers()['content-length']) > this.config.maxFileBytes) throw new LogError('FILE_TOO_LARGE', '文件超过 maxFileBytes');
        const body = await res.body();
        if (body.length > this.config.maxFileBytes) throw new LogError('FILE_TOO_LARGE', '文件超过 maxFileBytes');
        settle({ body, url: res.url() });
      } catch (error) { reject(error); }
    };
    context.on('response', response);
    timer = setTimeout(() => reject(new LogError('DOWNLOAD_TIMEOUT', '下载未完成，请检查认证、新窗口或下载按钮适配')), this.config.timeoutMs);
    try {
      // Handle Chromium's ERR_ABORTED for an attachment navigation via the download event.
      void action().catch(error => {
        if (!/ERR_ABORTED|Download is starting/i.test(String(error))) {
          const code = String(error).match(/(?:net::)?ERR_[A-Z_]+/)?.[0] ?? 'NAVIGATION_FAILED';
          reject(new LogError('DOWNLOAD_FAILED', `无法打开下载链接（${code}），请检查认证及页面`));
        }
      });
      const value = await result;
      if (/^\s*(?:<!doctype html|<html)/i.test(value.body.toString('utf8', 0, 200))) throw new LogError('NOT_A_LOG', '下载返回 HTML 登录页，未保存为日志');
      return value;
    } finally {
      clearTimeout(timer!);
      context.off('page', attach); context.off('response', response);
      for (const page of attached) page.off('download', download);
      for (const page of context.pages()) if (!initialPages.has(page)) await page.close().catch(() => {});
    }
  }

  async download(hit: Hit): Promise<Buffer> {
    const row = await this.row(hit);
    try {
      const result = await this.collectDownload(() => row.locator(this.config.selectors.downloadButton).first().click());
      hit.downloadUrl = result.url;
      return result.body;
    } finally {
      if (this.page && !this.page.isClosed() && this.page.url() !== this.config.url) await this.page.goto(this.config.url).catch(() => {});
    }
  }

  async downloadAdjacent(hit: Hit, file: string): Promise<Buffer> {
    if (!hit.downloadUrl) throw new LogError('ADJACENT_URL_UNKNOWN', '先下载命中文件以发现真实下载地址');
    const url = adjacentUrl(hit.downloadUrl, hit.file, file);
    const result = await this.collectDownload(async () => {
      const page = await this.context!.newPage();
      return page.goto(url, { waitUntil: 'domcontentloaded' });
    });
    return result.body;
  }

  async close() { await this.context?.close(); }
}
