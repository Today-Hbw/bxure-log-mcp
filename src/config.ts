import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selectors = z.object({
  instanceItems: z.string().default('.el-tree-node__label'),
  startTime: z.string().default('.el-date-editor .el-range-input >> nth=0'),
  endTime: z.string().default('.el-date-editor .el-range-input >> nth=1'),
  pickerStartDate: z.string().default('.el-picker__popper:visible input[placeholder="开始日期"]'),
  pickerStartTime: z.string().default('.el-picker__popper:visible input[placeholder="开始时间"]'),
  pickerEndDate: z.string().default('.el-picker__popper:visible input[placeholder="结束日期"]'),
  pickerEndTime: z.string().default('.el-picker__popper:visible input[placeholder="结束时间"]'),
  pickerConfirm: z.string().default('.el-picker__popper:visible .el-picker-panel__link-btn:has-text("确定")'),
  keyword: z.string().default('input[placeholder="搜索关键字"]'),
  searchButton: z.string().default("button:has-text('搜索')"),
  resultRows: z.string().default('.el-table__body-wrapper tbody tr'),
  cells: z.string().default('td'),
  loading: z.string().default('.el-loading-mask:visible'),
  empty: z.string().default('.el-table__empty-text'),
  limitIndicator: z.string().default(''),
  previewButton: z.string().default('text=预览'),
  downloadButton: z.string().default('text=下载'),
  previewContent: z.string().default('.log-preview-drawer:visible .view-lines'),
  previewClose: z.string().default('.log-preview-drawer:visible .el-drawer__close-btn'),
}).strict();

export const configSchema = z.object({
  url: z.url().default('https://bxure-v3.ben.com/Pre/log'),
  timezone: z.string().default('Asia/Shanghai'),
  profile: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('default'),
  dataDir: z.string().default('.bxure'),
  headless: z.boolean().default(false),
  browserChannel: z.enum(['chromium', 'chrome', 'msedge']).default('chromium'),
  resultLimit: z.number().int().positive().nullable().default(null),
  maxQueries: z.number().int().min(1).max(256).default(32),
  minSliceSeconds: z.number().int().min(1).default(1),
  maxFileBytes: z.number().int().min(1024).max(100 * 1024 * 1024).default(20 * 1024 * 1024),
  timeoutMs: z.number().int().min(1000).max(120000).default(30000),
  encoding: z.string().default('utf-8'),
  selectors: selectors.default(() => selectors.parse({})),
}).strict();
export type Config = z.infer<typeof configSchema>;

export async function loadConfig(): Promise<Config> {
  let raw: Record<string, unknown> = {};
  if (process.env.BXURE_CONFIG) {
    raw = JSON.parse(await readFile(path.resolve(process.env.BXURE_CONFIG), 'utf8'));
  }
  const config = configSchema.parse({ ...raw, ...(process.env.BXURE_PROFILE ? { profile: process.env.BXURE_PROFILE } : {}) });
  config.dataDir = path.resolve(projectRoot, config.dataDir);
  new Intl.DateTimeFormat('en', { timeZone: config.timezone });
  new TextDecoder(config.encoding);
  if (!['http:', 'https:'].includes(new URL(config.url).protocol)) throw new Error('日志平台必须为 HTTP(S) URL');
  return config;
}
