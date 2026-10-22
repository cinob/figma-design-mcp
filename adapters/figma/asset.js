import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseFigmaUrl, getFigmaToken, fetchFigmaImages, fetchFigmaImageFills, fetchFigmaNodes } from './shared.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

cli({
  site: 'figma',
  name: 'asset',
  description: 'Download SVG/PNG/JPG renders or image fills from a Figma node',
  access: 'read',
  example: 'opencli figma asset <url> --node 1:2 --type svg --out ./assets -f json',
  domain: 'figma.com',
  strategy: Strategy.PUBLIC,
  defaultFormat: 'json',
  args: [
    { name: 'url', type: 'string', required: true, positional: true, help: 'Figma design URL or fileKey' },
    { name: 'node', type: 'string', help: 'Node ID to download asset from (e.g. 1:2 or 1-2)' },
    { name: 'type', type: 'string', default: 'png', help: 'Format: svg, png, jpg, pdf, or image' },
    { name: 'scale', type: 'float', default: 2, help: 'Render scale multiplier (e.g. 1, 2, 3)' },
    { name: 'name', type: 'string', help: 'Custom filename for the saved file' },
    { name: 'out', type: 'string', help: 'Output directory or target file path. Defaults to current directory.' },
    { name: 'token', type: 'string', help: 'Figma Personal Access Token' },
  ],
  columns: ['success', 'path', 'size', 'name', 'url'],
  func: async (args) => {
    const url = args.url;
    if (!url) throw new ArgumentError('url is required');

    const ids = parseFigmaUrl(url);
    if (!ids?.fileKey) throw new ArgumentError('Could not parse Figma file key from URL.');

    const nodeId = (args.node || ids.nodeId || '').replace(/-/g, ':');
    if (!nodeId) throw new ArgumentError('--node is required or must be present in the URL query (?node-id=...)');

    const format = (args.type || 'png').toLowerCase();
    const scale = Number(args.scale ?? 2);
    const token = getFigmaToken(args);

    let downloadUrl = null;
    let fallbackName = `figma_${nodeId.replace(/:/g, '_')}`;
    let extension = `.${format}`;

    if (format === 'image') {
      // 1. Fetch node to find image fill reference
      const nodeData = await fetchFigmaNodes(ids.fileKey, nodeId, token);
      const targetNode = nodeData?.nodes?.[nodeId]?.document;
      if (!targetNode) throw new EmptyResultError('figma/asset', `Node "${nodeId}" not found.`);
      if (targetNode.name) fallbackName = targetNode.name;

      const imageFill = (targetNode.fills || []).find((f) => f.type === 'IMAGE' && f.imageRef);
      if (!imageFill) {
        throw new ArgumentError(`Node "${nodeId}" does not contain an IMAGE fill.`);
      }

      // 2. Fetch images map
      const imageMap = await fetchFigmaImageFills(ids.fileKey, token);
      downloadUrl = imageMap?.meta?.images?.[imageFill.imageRef];
      if (!downloadUrl) {
        throw new EmptyResultError('figma/asset', `No downloadable image URL found for imageRef ${imageFill.imageRef}.`);
      }
      extension = '.png';
    } else {
      // Render asset using Figma Images API
      const imagesData = await fetchFigmaImages(ids.fileKey, nodeId, token, {
        format,
        scale,
        svg_include_id: true,
      });

      downloadUrl = imagesData?.images?.[nodeId];
      if (!downloadUrl) {
        throw new EmptyResultError('figma/asset', `Failed to render image for node "${nodeId}".`);
      }

      // Try getting node name for a better filename
      try {
        const nodeData = await fetchFigmaNodes(ids.fileKey, nodeId, token);
        const targetNode = nodeData?.nodes?.[nodeId]?.document;
        if (targetNode?.name) fallbackName = targetNode.name;
      } catch {}
    }

    // Download binary
    const resp = await fetch(downloadUrl);
    if (!resp.ok) throw new Error(`Asset download failed: HTTP ${resp.status}`);
    const arrayBuffer = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Resolve output path
    let outDir = process.cwd();
    let finalFilename = '';

    if (args.out) {
      const resolvedOut = path.resolve(args.out);
      try {
        const stat = await fs.stat(resolvedOut);
        if (stat.isDirectory()) {
          outDir = resolvedOut;
        } else {
          outDir = path.dirname(resolvedOut);
          finalFilename = path.basename(resolvedOut);
        }
      } catch {
        if (path.extname(resolvedOut)) {
          outDir = path.dirname(resolvedOut);
          finalFilename = path.basename(resolvedOut);
        } else {
          outDir = resolvedOut;
        }
      }
    }

    await fs.mkdir(outDir, { recursive: true });

    if (!finalFilename) {
      let baseName = args.name || fallbackName;
      baseName = baseName.replace(/[^a-zA-Z0-9_\-一-龥]/g, '_');
      if (!baseName.toLowerCase().endsWith(extension)) {
        baseName += extension;
      }
      finalFilename = baseName;
    }

    const savePath = path.join(outDir, finalFilename);
    await fs.writeFile(savePath, buffer);

    return [{
      success: true,
      path: savePath,
      size: buffer.length,
      name: finalFilename,
      url: downloadUrl,
    }];
  },
});
