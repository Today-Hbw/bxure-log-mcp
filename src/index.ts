#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { BrowserBackend } from './browser.js';
import { LogService } from './service.js';
import { createServer } from './server.js';

async function main() {
  const config = await loadConfig();
  const backend = new BrowserBackend(config);
  const server = createServer(new LogService(backend, config));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await backend.close().catch(() => {});
    await server.close().catch(() => {});
  };
  process.on('SIGINT', () => { void close(); });
  process.on('SIGTERM', () => { void close(); });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.on('end', () => { void close(); });
}
main().catch(() => {
  console.error('Bxure MCP 启动失败，请检查 BXURE_CONFIG、配置格式与依赖安装。');
  process.exitCode = 1;
});
