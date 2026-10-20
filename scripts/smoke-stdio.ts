import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { projectRoot } from '../src/config.js';

const client = new Client({ name: 'bxure-stdio-check', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, 'dist', 'index.js')], stderr: 'pipe' });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 8) throw new Error('Expected eight MCP tools');
  const error = await client.callTool({ name: 'download_log', arguments: { hitId: 'a'.repeat(24) } });
  if (!error.isError || !JSON.stringify(error.content).includes('HIT_NOT_FOUND')) throw new Error('Error response was not actionable');
  console.log('STDIO handshake, eight tools, and error response passed. Browser was not started.');
} finally { await client.close(); }
