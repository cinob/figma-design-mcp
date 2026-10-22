import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { parseFigmaUrl, getFigmaToken, fetchFigmaFile, extractDesignMeta } from './shared.js';

cli({
  site: 'figma',
  name: 'design',
  description: 'Open a Figma design URL and return design/page/frame metadata as JSON',
  access: 'read',
  example: 'opencli figma design <url> -f json',
  domain: 'figma.com',
  strategy: Strategy.PUBLIC,
  defaultFormat: 'json',
  args: [
    { name: 'url', type: 'string', required: true, positional: true, help: 'Figma design URL or fileKey' },
    { name: 'token', type: 'string', help: 'Figma Personal Access Token' },
  ],
  columns: ['title', 'lastModified', 'pageCount', 'frameCount'],
  func: async (args) => {
    const url = args.url;
    if (!url) throw new ArgumentError('url is required');

    const ids = parseFigmaUrl(url);
    if (!ids?.fileKey) {
      throw new ArgumentError('Could not parse Figma file key from URL or input.');
    }

    const token = getFigmaToken(args);
    const fileData = await fetchFigmaFile(ids.fileKey, token, { depth: 2 });
    const meta = extractDesignMeta(fileData);

    return [{
      title: meta.title,
      lastModified: meta.lastModified,
      pageCount: meta.pageCount,
      frameCount: meta.frameCount,
    }];
  },
});
