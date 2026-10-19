import { loadConfig } from './config.js';
import { BrowserBackend } from './browser.js';
import { createInterface } from 'node:readline/promises';

const backend = new BrowserBackend(await loadConfig());
const input = createInterface({ input: process.stdin, output: process.stdout });
try {
  const result = await backend.open();
  console.log(result.message);
  await input.question('请在浏览器中完成登录及项目初始化，再进入日志页。完成后在终端按 Enter 保存并关闭浏览器：');
  console.log(await backend.open());
} finally { input.close(); await backend.close(); }
