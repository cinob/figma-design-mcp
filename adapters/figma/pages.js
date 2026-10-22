import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseFigmaUrl, getFigmaToken, fetchFigmaFile, fetchProjectFiles } from './shared.js';

cli({
  site: 'figma',
  name: 'pages',
  description: 'List pages/canvases/frames in a Figma file, or files in a Figma project',
  access: 'read',
  example: 'opencli figma pages <url> --limit 50 -f json',
  domain: 'figma.com',
  strategy: Strategy.PUBLIC,
  defaultFormat: 'json',
  args: [
    { name: 'url', type: 'string', required: true, positional: true, help: 'Figma file URL or project URL' },
    { name: 'limit', type: 'int', default: 500, help: 'Max items to return' },
    { name: 'token', type: 'string', help: 'Figma Personal Access Token' },
  ],
  columns: ['id', 'name', 'type', 'parentId', 'fileKey', 'url'],
  func: async (args) => {
    const url = args.url;
    if (!url) throw new ArgumentError('url is required');

    const limit = Number(args.limit ?? 500);
    const ids = parseFigmaUrl(url);
    const token = getFigmaToken(args);
    const rows = [];

    // Case 1: Project URL -> list project files
    if (ids?.projectId && !ids?.fileKey) {
      const projectData = await fetchProjectFiles(ids.projectId, token);
      const files = projectData?.files || [];
      for (const f of files.slice(0, limit)) {
        rows.push({
          id: String(f.key || ''),
          name: String(f.name || 'Untitled File'),
          type: 'file',
          parentId: ids.projectId,
          fileKey: String(f.key || ''),
          url: `https://www.figma.com/design/${f.key}/${encodeURIComponent(f.name || '')}`,
        });
      }
    } else if (ids?.fileKey) {
      // Case 2: File URL -> list pages (Canvas) and top-level Frames
      const fileData = await fetchFigmaFile(ids.fileKey, token, { depth: 2 });
      const document = fileData?.document || {};
      const canvases = (document.children || []).filter((c) => c.type === 'CANVAS');

      for (const canvas of canvases) {
        if (rows.length >= limit) break;
        const pageUrl = `https://www.figma.com/design/${ids.fileKey}/${encodeURIComponent(fileData.name || '')}?node-id=${encodeURIComponent(canvas.id.replace(/:/g, '-'))}`;
        rows.push({
          id: String(canvas.id || ''),
          name: String(canvas.name || 'Untitled Page'),
          type: 'page',
          parentId: ids.fileKey,
          fileKey: ids.fileKey,
          url: pageUrl,
        });

        // Also list top-level frames inside page
        for (const child of canvas.children || []) {
          if (rows.length >= limit) break;
          if (child.type === 'FRAME' || child.type === 'COMPONENT' || child.type === 'SECTION') {
            const frameUrl = `https://www.figma.com/design/${ids.fileKey}/${encodeURIComponent(fileData.name || '')}?node-id=${encodeURIComponent(child.id.replace(/:/g, '-'))}`;
            rows.push({
              id: String(child.id || ''),
              name: String(child.name || 'Untitled Frame'),
              type: child.type.toLowerCase(),
              parentId: String(canvas.id || ''),
              fileKey: ids.fileKey,
              url: frameUrl,
            });
          }
        }
      }
    } else {
      throw new ArgumentError('Could not parse a valid Figma fileKey or projectId from URL.');
    }

    if (rows.length === 0) {
      throw new EmptyResultError('figma/pages', 'No pages or files found in target.');
    }

    return rows;
  },
});
