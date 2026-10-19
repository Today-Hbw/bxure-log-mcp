import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configSchema } from '../src/config.js';
import { LogService } from '../src/service.js';
import { createServer } from '../src/server.js';
import type { LogBackend } from '../src/types.js';

test('MCP handshake, schemas, structured results and actionable errors', async () => {
  const backend: LogBackend = {
    open: async () => ({ ready: true, url: 'http://localhost', message: 'ready' }),
    listInstances: async () => ['runner-a'], search: async () => ({ hits: [], capped: undefined }),
    preview: async () => '', download: async () => Buffer.from(''), downloadAdjacent: async () => Buffer.from(''), close: async () => {},
  };
  const server = createServer(new LogService(backend, configSchema.parse({})));
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 7);
    const instances = await client.callTool({ name: 'list_instances', arguments: {} });
    assert.deepEqual(instances.structuredContent, { instances: ['runner-a'] });
    const result = await client.callTool({ name: 'search_logs', arguments: { keyword: 'boom' } });
    assert.equal(result.structuredContent?.completeness, 'unconfirmed');
    const error = await client.callTool({ name: 'download_log', arguments: { hitId: 'a'.repeat(24) } });
    assert.equal(error.isError, true);
    assert.match(JSON.stringify(error.content), /HIT_NOT_FOUND/);
  } finally { await client.close(); await server.close(); }
});
