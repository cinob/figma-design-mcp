import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cachedOpenCli } from './cache.js';

test('node cache persists, separates requests, expires and refreshes', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'figma-cache-test-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let calls = 0;
  const options = {
    workspace, toolDir: workspace, command: 'tree', args: ['file', '--frame', '1:2'],
    run: async () => ({ value: ++calls, secret: 'private' }),
    sanitize: ({ value }) => ({ value }),
  };
  assert.deepEqual(await cachedOpenCli(options), { value: 1 });
  assert.deepEqual(await cachedOpenCli(options), { value: 1 });
  assert.equal(calls, 1);
  const dir = join(workspace, '.figma-mcp', 'cache');
  const [filename] = await readdir(dir);
  assert.doesNotMatch(await readFile(join(dir, filename), 'utf8'), /private/);
  assert.deepEqual(await cachedOpenCli({ ...options, refresh: true }), { value: 2 });
  assert.deepEqual(await cachedOpenCli({ ...options, args: ['file', '--frame', '1:3'] }), { value: 3 });
  await writeFile(join(dir, filename), JSON.stringify({ createdAt: Date.now() - 3600001, result: { value: 0 } }));
  assert.deepEqual(await cachedOpenCli(options), { value: 4 });
  await writeFile(join(dir, filename), 'invalid json');
  assert.deepEqual(await cachedOpenCli(options), { value: 5 });
  await writeFile(join(workspace, '.env'), 'FIGMA_TOKEN=changed');
  assert.deepEqual(await cachedOpenCli(options), { value: 6 });
  await assert.rejects(cachedOpenCli({ ...options, refresh: true, run: async () => { throw new Error('API failed'); } }), /API failed/);
  assert.deepEqual(await cachedOpenCli(options), { value: 6 });
});

test('MCP node tools read cached results from the selected workspace', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'figma-mcp-test-'));
  const toolDir = dirname(fileURLToPath(import.meta.url));
  const url = 'https://www.figma.com/design/abcdefghijklmnopqrstuv/example';
  const run = async () => [{ id: '1:2', name: 'Cached node' }];
  const sanitize = (value) => value;
  const common = { workspace, toolDir, run, sanitize };
  await cachedOpenCli({ ...common, command: 'style', args: [url, '--node', '1:2', '--style-type', 'auto', '--workspace', workspace] });
  await cachedOpenCli({ ...common, command: 'tree', args: [url, '--max-depth', '99', '--style-type', 'auto', '--workspace', workspace, '--frame', '1:2', '--with-style'] });
  await mkdir(join(workspace, '.figma-mcp'), { recursive: true });
  await writeFile(join(workspace, '.figma-mcp', 'catalog.json'), JSON.stringify({ designs: [{ id: '1:2', name: 'Frame', type: 'frame', url }] }));

  const client = new Client({ name: 'cache-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(toolDir, 'server.js')], cwd: workspace });
  t.after(async () => {
    await client.close();
    await rm(workspace, { recursive: true, force: true });
  });
  await client.connect(transport);
  const style = await client.callTool({ name: 'figma_get_node_style', arguments: { url, node: '1:2', workspaceDir: workspace } });
  assert.equal(JSON.parse(style.content[0].text)[0].name, 'Cached node');
  const tree = await client.callTool({ name: 'figma_get_tree', arguments: { url, frame: '1:2', withStyle: true, workspaceDir: workspace } });
  assert.equal(JSON.parse(tree.content[0].text)[0].name, 'Cached node');
  const byName = await client.callTool({ name: 'figma_get_tree_by_name', arguments: { name: 'Frame', workspaceDir: workspace } });
  assert.equal(JSON.parse(byName.content[0].text).tree[0].name, 'Cached node');
});
