import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseFigmaUrl, getFigmaToken, fetchFigmaFile, fetchFigmaNodes, extractTree } from './shared.js';

cli({
  site: 'figma',
  name: 'tree',
  description: 'Return full Figma layer tree with CSS declarations and framework-adaptive utility classes',
  access: 'read',
  example: 'opencli figma tree <url> --with-style [--style-type auto|unocss|tailwind|css] -f json',
  domain: 'figma.com',
  strategy: Strategy.PUBLIC,
  defaultFormat: 'json',
  args: [
    { name: 'url', type: 'string', required: true, positional: true, help: 'Figma design URL or fileKey' },
    { name: 'frame', type: 'string', default: '', help: 'Filter tree by frame/page ID or name' },
    { name: 'with-style', type: 'boolean', default: false, help: 'Include normalized style data, CSS, and classes for every node' },
    { name: 'style-type', type: 'string', default: 'auto', help: 'Styling engine: auto (detect from workspace), unocss, tailwind, or css' },
    { name: 'workspace', type: 'string', help: 'Target project root directory for auto-detecting framework & styling' },
    { name: 'max-depth', type: 'int', default: 99, help: 'Maximum child depth to include' },
    { name: 'token', type: 'string', help: 'Figma Personal Access Token' },
  ],
  columns: ['id', 'name', 'type', 'x', 'y', 'width', 'height', 'text', 'style', 'css', 'classes', 'unocss', 'children'],
  func: async (args) => {
    const url = args.url;
    if (!url) throw new ArgumentError('url is required');

    const maxDepth = Number(args['max-depth'] ?? args.maxDepth ?? 99);
    if (!Number.isInteger(maxDepth) || maxDepth < 0) {
      throw new ArgumentError('--max-depth must be a non-negative integer');
    }

    const ids = parseFigmaUrl(url);
    if (!ids?.fileKey) throw new ArgumentError('Could not parse Figma file key from URL.');

    const frameFilter = (args.frame || ids.nodeId || '').replace(/-/g, ':');
    const token = getFigmaToken(args);

    let rootData = null;

    if (frameFilter && frameFilter.includes(':')) {
      try {
        const nodeData = await fetchFigmaNodes(ids.fileKey, frameFilter, token, {
          depth: maxDepth < 99 ? maxDepth + 1 : undefined,
        });
        const targetNode = nodeData?.nodes?.[frameFilter]?.document;
        if (targetNode) {
          rootData = { document: { children: [targetNode] } };
        }
      } catch {
        // Fall back to whole file fetch
      }
    }

    if (!rootData) {
      rootData = await fetchFigmaFile(ids.fileKey, token, {
        depth: maxDepth < 99 ? maxDepth + 2 : undefined,
      });
    }

    const tree = extractTree(rootData, frameFilter || null, {
      withStyle: Boolean(args['with-style'] ?? args.withStyle),
      styleType: args['style-type'] || args.styleType || 'auto',
      workspaceDir: args.workspace || process.cwd(),
      maxDepth,
    });

    if (tree.length === 0) {
      throw new EmptyResultError('figma/tree', 'No tree nodes found matching criteria.');
    }

    return tree;
  },
});
