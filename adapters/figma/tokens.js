import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, EmptyResultError } from '@jackwener/opencli/errors';
import { parseFigmaUrl, getFigmaToken, fetchFigmaFile, extractTokens } from './shared.js';

cli({
  site: 'figma',
  name: 'tokens',
  description: 'Extract reusable design tokens (colors, fontSizes, fontWeights, radii, spacing) from a Figma design',
  access: 'read',
  example: 'opencli figma tokens <url> -f json',
  domain: 'figma.com',
  strategy: Strategy.PUBLIC,
  defaultFormat: 'json',
  args: [
    { name: 'url', type: 'string', required: true, positional: true, help: 'Figma design URL or fileKey' },
    { name: 'token', type: 'string', help: 'Figma Personal Access Token' },
  ],
  columns: ['colors', 'fontSizes', 'fontWeights', 'radii', 'spacing'],
  func: async (args) => {
    const url = args.url;
    if (!url) throw new ArgumentError('url is required');

    const ids = parseFigmaUrl(url);
    if (!ids?.fileKey) throw new ArgumentError('Could not parse Figma file key from URL.');

    const token = getFigmaToken(args);
    const fileData = await fetchFigmaFile(ids.fileKey, token);
    const tokens = extractTokens(fileData);

    if (
      (!tokens.colors || tokens.colors.length === 0) &&
      (!tokens.fontSizes || tokens.fontSizes.length === 0) &&
      (!tokens.radii || tokens.radii.length === 0) &&
      (!tokens.spacing || tokens.spacing.length === 0)
    ) {
      throw new EmptyResultError('figma/tokens', 'No design tokens found in design.');
    }

    return [{
      colors: tokens.colors || [],
      fontSizes: tokens.fontSizes || [],
      fontWeights: tokens.fontWeights || [],
      radii: tokens.radii || [],
      spacing: tokens.spacing || [],
    }];
  },
});
