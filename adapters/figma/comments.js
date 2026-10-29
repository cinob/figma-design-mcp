import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError } from '@jackwener/opencli/errors';
import { parseFigmaUrl, getFigmaToken, fetchFigmaComments } from './shared.js';

cli({
  site: 'figma',
  name: 'comments',
  description: 'Get comments from a Figma design URL or fileKey, with node targeting and pin coordinates',
  access: 'read',
  example: 'opencli figma comments <url> --node 1:2 --unresolved-only -f json',
  domain: 'figma.com',
  strategy: Strategy.PUBLIC,
  defaultFormat: 'json',
  args: [
    { name: 'url', type: 'string', required: true, positional: true, help: 'Figma design URL or fileKey' },
    { name: 'node', type: 'string', help: 'Filter comments by target node ID (e.g. 1:2 or 1-2)' },
    { name: 'unresolved-only', type: 'boolean', default: false, help: 'Only return unresolved comments' },
    { name: 'token', type: 'string', help: 'Figma Personal Access Token' },
  ],
  columns: ['id', 'user', 'message', 'nodeId', 'resolved', 'createdAt'],
  func: async (args) => {
    const url = args.url;
    if (!url) throw new ArgumentError('url is required');

    const ids = parseFigmaUrl(url);
    if (!ids?.fileKey) {
      throw new ArgumentError('Could not parse Figma file key from URL or input.');
    }

    const token = getFigmaToken(args);
    const data = await fetchFigmaComments(ids.fileKey, token);
    const rawComments = Array.isArray(data?.comments) ? data.comments : [];

    const targetNodeId = (args.node || ids.nodeId || '').replace(/-/g, ':') || null;
    const unresolvedOnly = Boolean(args['unresolved-only']);

    // Build targeted comment IDs set so replies (threads) to the target comment are preserved
    const targetCommentIds = new Set();
    if (targetNodeId) {
      for (const c of rawComments) {
        const rawNode = c.client_meta?.node_id ? String(c.client_meta.node_id).replace(/-/g, ':') : null;
        if (rawNode === targetNodeId) {
          targetCommentIds.add(c.id);
        }
      }
    }

    const normalized = rawComments
      .filter((c) => {
        if (unresolvedOnly && c.resolved_at) return false;

        if (targetNodeId) {
          const rawNode = c.client_meta?.node_id ? String(c.client_meta.node_id).replace(/-/g, ':') : null;
          const isDirectNodeMatch = rawNode === targetNodeId;
          const isReplyToTarget = Boolean(c.parent_id && targetCommentIds.has(c.parent_id));
          return isDirectNodeMatch || isReplyToTarget;
        }

        return true;
      })
      .map((c) => ({
        id: c.id,
        parentId: c.parent_id || null,
        message: c.message,
        user: c.user?.handle || c.user?.id || 'Unknown',
        userAvatar: c.user?.img_url || null,
        createdAt: c.created_at,
        resolvedAt: c.resolved_at || null,
        resolved: Boolean(c.resolved_at),
        nodeId: c.client_meta?.node_id ? String(c.client_meta.node_id).replace(/-/g, ':') : null,
        nodeOffset: c.client_meta?.node_offset || null,
        point: c.client_meta?.point || null,
      }));

    return normalized;
  },
});
