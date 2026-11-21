import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { parseFigmaUrl, getFigmaToken, fetchFigmaFile, fetchFigmaNodes, extractAnnotations } from './shared.js';

cli({
  site: 'figma',
  name: 'annotations',
  description: 'Get Dev Mode annotations (designer notes and pinned properties) from a Figma design, grouped by node',
  access: 'read',
  example: 'opencli figma annotations <url> [--node 1:2] -f json',
  domain: 'figma.com',
  strategy: Strategy.PUBLIC,
  defaultFormat: 'json',
  args: [
    { name: 'url', type: 'string', required: true, positional: true, help: 'Figma design URL or fileKey' },
    { name: 'node', type: 'string', help: 'Only return annotations under this node ID (e.g. 1:2 or 1-2)' },
    { name: 'token', type: 'string', help: 'Figma Personal Access Token' },
  ],
  columns: ['nodeId', 'nodeName', 'nodeType', 'path', 'annotations'],
  func: async (args) => {
    const url = args.url;
    if (!url) throw new ArgumentError('url is required');

    const ids = parseFigmaUrl(url);
    if (!ids?.fileKey) throw new ArgumentError('Could not parse Figma file key from URL.');

    const nodeFilter = (args.node || ids.nodeId || '').replace(/-/g, ':') || null;
    const figmaToken = getFigmaToken(args);

    // `annotations` only appears on annotated nodes and `depth` truncates the tree, so an unbounded fetch is required.
    // The nodes form returns { nodes: { [id]: { document } } } with no top-level document, so `--node` skips findFigmaNode.
    const fileData = nodeFilter
      ? await fetchFigmaNodes(ids.fileKey, nodeFilter, figmaToken)
      : await fetchFigmaFile(ids.fileKey, figmaToken, {});
    const root = nodeFilter ? fileData?.nodes?.[nodeFilter]?.document : fileData?.document;

    // No annotations is a valid answer for a file, unlike the EmptyResultError used by the other adapters.
    return extractAnnotations(root);
  },
});
