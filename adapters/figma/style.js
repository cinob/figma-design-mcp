import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseFigmaUrl, getFigmaToken, fetchFigmaNodes, extractNodeStyle } from './shared.js';

cli({
  site: 'figma',
  name: 'style',
  description: 'Return normalized style data, CSS declarations, and framework-adaptive utility classes for a node',
  access: 'read',
  example: 'opencli figma style <url> --node 1:2 [--style-type auto|unocss|tailwind|css] -f json',
  domain: 'figma.com',
  strategy: Strategy.PUBLIC,
  defaultFormat: 'json',
  args: [
    { name: 'url', type: 'string', required: true, positional: true, help: 'Figma design URL or fileKey' },
    { name: 'node', type: 'string', help: 'Node ID to extract style from (e.g. 1:2 or 1-2)' },
    { name: 'style-type', type: 'string', default: 'auto', help: 'Styling engine: auto (detect from workspace), unocss, tailwind, or css' },
    { name: 'workspace', type: 'string', help: 'Target project root directory for auto-detecting framework & styling' },
    { name: 'token', type: 'string', help: 'Figma Personal Access Token' },
  ],
  columns: [
    'id', 'name', 'type', 'bboxX', 'bboxY', 'bboxW', 'bboxH',
    'background', 'color', 'fontSize', 'fontWeight', 'borderRadius', 'opacity', 'css', 'classes',
  ],
  func: async (args) => {
    const url = args.url;
    if (!url) throw new ArgumentError('url is required');

    const ids = parseFigmaUrl(url);
    if (!ids?.fileKey) throw new ArgumentError('Could not parse Figma file key from URL.');

    const nodeId = (args.node || ids.nodeId || '').replace(/-/g, ':');
    if (!nodeId) throw new ArgumentError('--node is required or must be present in the URL query (?node-id=...)');

    const token = getFigmaToken(args);
    const nodeData = await fetchFigmaNodes(ids.fileKey, nodeId, token);
    const nodesMap = nodeData?.nodes || {};
    const targetNode = nodesMap[nodeId]?.document;

    if (!targetNode) {
      throw new EmptyResultError('figma/style', `Node "${nodeId}" not found in Figma file.`);
    }

    const rows = extractNodeStyle({ document: { children: [targetNode] } }, nodeId, {
      styleType: args['style-type'] || args.styleType || 'auto',
      workspaceDir: args.workspace || process.cwd(),
    });

    if (rows.length === 0) {
      throw new EmptyResultError('figma/style', `Failed to parse style for node "${nodeId}".`);
    }

    return rows;
  },
});
