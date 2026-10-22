import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseFigmaUrl, getFigmaToken, fetchFigmaFile, extractLayers } from './shared.js';

cli({
  site: 'figma',
  name: 'layers',
  description: 'Return frame or page layer data from a Figma design URL as JSON',
  access: 'read',
  example: 'opencli figma layers <url> --frame 1:2 --limit 50 -f json',
  domain: 'figma.com',
  strategy: Strategy.PUBLIC,
  defaultFormat: 'json',
  args: [
    { name: 'url', type: 'string', required: true, positional: true, help: 'Figma design URL or fileKey' },
    { name: 'frame', type: 'string', default: '', help: 'Filter layers by frame/page ID or name' },
    { name: 'limit', type: 'int', default: 50, help: 'Max layers to return (1-5000)' },
    { name: 'token', type: 'string', help: 'Figma Personal Access Token' },
  ],
  columns: ['id', 'name', 'type', 'x', 'y', 'width', 'height'],
  func: async (args) => {
    const url = args.url;
    if (!url) throw new ArgumentError('url is required');

    const limit = Number(args.limit ?? 50);
    if (!Number.isInteger(limit) || limit <= 0) throw new ArgumentError('limit must be a positive integer');

    const ids = parseFigmaUrl(url);
    if (!ids?.fileKey) throw new ArgumentError('Could not parse Figma file key from URL.');

    const frameFilter = args.frame || ids.nodeId || null;
    const token = getFigmaToken(args);

    const fileData = await fetchFigmaFile(ids.fileKey, token);
    const layers = extractLayers(fileData, frameFilter, limit);

    if (layers.length === 0) {
      throw new EmptyResultError('figma/layers', 'No layers found in design matching criteria.');
    }

    return layers;
  },
});
