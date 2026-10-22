#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const require = createRequire(import.meta.url);
const toolDir = dirname(fileURLToPath(import.meta.url));
const opencliMain = require.resolve('@jackwener/opencli');
const OUTPUT_LIMIT = 25 * 1024 * 1024;
const FIGMA_DIR = '.figma-mcp';
const SENSITIVE_KEY_RE = /(^|[_-])(access[_-]?token|api[_-]?key|authorization|client[_-]?secret|cookie|cookies|credential|credentials|csrf|jwt|password|private[_-]?key|refresh[_-]?token|secret|session|token|figma[_-]?token|x-figma-token)([_-]|$)/i;

const server = new McpServer({
  name: 'figma-design-mcp',
  version: '1.0.0',
});

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function sanitizeUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return stripAnsi(String(value));
  }
}

function redactText(value) {
  return stripAnsi(String(value))
    .replace(/figd_[A-Za-z0-9_-]{20,}/g, '[REDACTED_FIGMA_TOKEN]')
    .replace(/https?:\/\/[^\s"'<>]+/g, (match) => sanitizeUrl(match))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/ig, '$1[REDACTED]')
    .replace(/(cookie\s*[:=]\s*)[^\n]+/ig, '$1[REDACTED]')
    .replace(/\b(access[_-]?token|api[_-]?key|authorization|client[_-]?secret|csrf|jwt|password|refresh[_-]?token|secret|session|token|figma[_-]?token|x-figma-token)\s*[:=]\s*[^\s,;&"'<>]+/ig, '$1=[REDACTED]');
}

function redactData(value, key = '') {
  if (SENSITIVE_KEY_RE.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactData(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactData(entryValue, entryKey)]),
    );
  }
  if (typeof value === 'string') {
    if (/url$/i.test(key) || /^url$/i.test(key)) return sanitizeUrl(value);
    return redactText(value);
  }
  return value;
}

function extractJson(output) {
  const clean = stripAnsi(output).trim();
  if (!clean) throw new Error('OpenCLI returned empty stdout');

  try {
    return JSON.parse(clean);
  } catch {}

  const starts = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '[' || clean[i] === '{') starts.push(i);
  }

  for (const start of starts) {
    const stack = [];
    let inString = false;
    let escaped = false;

    for (let i = start; i < clean.length; i++) {
      const ch = clean[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '[' || ch === '{') {
        stack.push(ch);
        continue;
      }

      if (ch === ']' || ch === '}') {
        const open = stack.pop();
        if ((ch === ']' && open !== '[') || (ch === '}' && open !== '{')) break;
        if (stack.length === 0) {
          const candidate = clean.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new Error(`Could not parse JSON from OpenCLI stdout: ${redactText(clean.slice(0, 500))}`);
}

function runOpenCli(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const cliArgs = [opencliMain, 'figma', command, ...args, '-f', 'json'];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs, {
      cwd: toolDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let outputSize = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`opencli figma ${command} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    function append(which, chunk) {
      outputSize += chunk.length;
      if (outputSize > OUTPUT_LIMIT) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill('SIGTERM');
          reject(new Error(`opencli figma ${command} output exceeded ${OUTPUT_LIMIT} bytes`));
        }
        return;
      }
      if (which === 'stdout') stdout += chunk;
      else stderr += chunk;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        const details = [
          `opencli figma ${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
          stderr.trim() ? `stderr: ${redactText(stderr.trim().slice(0, 1000))}` : null,
          stdout.trim() ? `stdout: ${redactText(stdout.trim().slice(0, 1000))}` : null,
        ].filter(Boolean).join('\n');
        reject(new Error(details));
        return;
      }

      try {
        resolve(extractJson(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function jsonResponse(result) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(redactData(result), null, 2),
      },
    ],
  };
}

function optionalStringArg(args, name, value) {
  if (value && String(value).trim()) args.push(name, String(value));
}

function resolveWorkspaceDir(workspaceDir) {
  if (!workspaceDir || !String(workspaceDir).trim()) {
    throw new Error('workspaceDir is required and must point to the real frontend project root.');
  }
  if (!isAbsolute(workspaceDir)) {
    throw new Error('workspaceDir must be an absolute path to the real frontend project root.');
  }
  return resolve(workspaceDir);
}

function figmaDirFor(workspaceDir) {
  return join(resolveWorkspaceDir(workspaceDir), FIGMA_DIR);
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Failed to read JSON file ${filePath}: ${redactText(error.message)}`);
  }
}

async function writeJsonFile(filePath, data) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(redactData(data), null, 2)}\n`);
}

async function ensureJsonFile(filePath, data) {
  try {
    await readFile(filePath, 'utf8');
    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeJsonFile(filePath, data);
    return true;
  }
}

function cleanString(value) {
  return redactText(value ?? '').trim();
}

function cleanStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanString).filter(Boolean))];
}

function normalizePagesResult(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.pages)) return result.pages;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.data)) return result.data;
  throw new Error('figma pages did not return an array.');
}

function catalogPathFor(workspaceDir) {
  return join(figmaDirFor(workspaceDir), 'catalog.json');
}

function aliasesPathFor(workspaceDir) {
  return join(figmaDirFor(workspaceDir), 'aliases.json');
}

function catalogFallback() {
  return {
    version: 1,
    updatedAt: null,
    sources: [],
    designs: [],
  };
}

function indexPreviousDesigns(designs = []) {
  const index = new Map();
  for (const design of designs) {
    for (const key of [design.id, design.url, design.name].filter(Boolean)) {
      index.set(key, design);
    }
  }
  return index;
}

function normalizeCatalogDesign(page, previous, now) {
  const cleanUrl = sanitizeUrl(page.url ?? '');
  return {
    id: cleanString(page.id ?? page.fileKey ?? cleanUrl),
    name: cleanString(page.name ?? 'Untitled'),
    type: cleanString(page.type ?? 'frame'),
    url: cleanUrl,
    fileKey: cleanString(page.fileKey ?? ''),
    parentId: cleanString(page.parentId ?? ''),
    aliases: cleanStringList(previous?.aliases),
    tags: cleanStringList(previous?.tags),
    lastSyncedAt: now,
  };
}

function normalizeAliasEntries(aliases) {
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return [];
  return Object.entries(aliases).flatMap(([from, to]) => {
    const targets = Array.isArray(to) ? to : [to];
    return targets.map((target) => ({
      from: cleanString(from),
      to: cleanString(target),
    })).filter((entry) => entry.from && entry.to);
  });
}

function normalizeForSearch(value) {
  return String(value ?? '').trim().toLowerCase();
}

function designSummary(design) {
  return {
    id: design.id,
    name: design.name,
    type: design.type,
    url: design.url,
    fileKey: design.fileKey,
    parentId: design.parentId,
    aliases: design.aliases ?? [],
    tags: design.tags ?? [],
    lastSyncedAt: design.lastSyncedAt,
  };
}

function calculateMatchScore(exact, aliasMatch) {
  if (exact) {
    return { score: 100, matchReason: 'exact' };
  }
  if (aliasMatch) {
    return { score: 80, matchReason: 'alias-map' };
  }
  return { score: 50, matchReason: 'contains' };
}

function searchCatalog(catalog, aliases, query) {
  const q = normalizeForSearch(query);
  const aliasEntries = normalizeAliasEntries(aliases);
  const aliasTargets = new Set(
    aliasEntries
      .filter((entry) => normalizeForSearch(entry.from).includes(q) || normalizeForSearch(entry.to).includes(q))
      .map((entry) => normalizeForSearch(entry.to)),
  );

  return (catalog.designs ?? [])
    .map((design) => {
      const fields = [
        design.id,
        design.name,
        design.url,
        design.fileKey,
        ...(design.aliases ?? []),
        ...(design.tags ?? []),
      ].filter(Boolean);
      const normalizedFields = fields.map(normalizeForSearch);
      const exact = normalizedFields.some((field) => field === q);
      const includes = normalizedFields.some((field) => field.includes(q));
      const aliasMatch = aliasTargets.has(normalizeForSearch(design.name))
        || (design.aliases ?? []).some((alias) => aliasTargets.has(normalizeForSearch(alias)))
        || aliasTargets.has(normalizeForSearch(design.id));

      if (!exact && !includes && !aliasMatch) return null;
      return {
        ...calculateMatchScore(exact, aliasMatch),
        ...designSummary(design),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

async function readWorkspaceCatalog(workspaceDir) {
  return readJsonFile(catalogPathFor(workspaceDir), catalogFallback());
}

async function readWorkspaceAliases(workspaceDir) {
  return readJsonFile(aliasesPathFor(workspaceDir), {});
}

// -------------------------------------------------------------
// MCP Tools Registration
// -------------------------------------------------------------

server.registerTool('figma_get_design', {
  title: 'Get Figma design metadata',
  description: 'Return design metadata (title, page count, frame count, thumbnail) for a Figma design URL or fileKey.',
  inputSchema: {
    url: z.string().min(1).describe('Figma design URL (e.g. https://www.figma.com/design/:fileKey/...) or fileKey'),
    token: z.string().optional().describe('Optional Figma Personal Access Token'),
  },
}, async ({ url, token }) => {
  const args = [url];
  optionalStringArg(args, '--token', token);
  const result = await runOpenCli('design', args);
  return jsonResponse(result);
});

server.registerTool('figma_list_layers', {
  title: 'List Figma layers',
  description: 'Return flattened layer data from a Figma design URL or frame.',
  inputSchema: {
    url: z.string().min(1).describe('Figma design URL or fileKey'),
    frame: z.string().optional().describe('Optional frame/page ID filter (e.g. 1:2)'),
    limit: z.number().int().min(1).max(5000).default(50).describe('Maximum layers to return'),
    token: z.string().optional().describe('Optional Figma Personal Access Token'),
  },
}, async ({ url, frame, limit, token }) => {
  const args = [url, '--limit', String(limit ?? 50)];
  optionalStringArg(args, '--frame', frame);
  optionalStringArg(args, '--token', token);
  const result = await runOpenCli('layers', args);
  return jsonResponse(result);
});

server.registerTool('figma_list_pages', {
  title: 'List Figma pages or project files',
  description: 'Return pages/frames in a Figma file, or all files in a Figma project.',
  inputSchema: {
    url: z.string().min(1).describe('Figma design URL or project URL'),
    limit: z.number().int().min(1).max(2000).default(500).describe('Maximum items to return'),
    token: z.string().optional().describe('Optional Figma Personal Access Token'),
  },
}, async ({ url, limit, token }) => {
  const args = [url, '--limit', String(limit ?? 500)];
  optionalStringArg(args, '--token', token);
  const result = await runOpenCli('pages', args);
  return jsonResponse(result);
});

server.registerTool('figma_detect_workspace', {
  title: 'Detect frontend workspace stack and styling engine',
  description: 'Inspect the target project root directory to automatically detect its frontend framework (Vue/Nuxt/React/uni-app/Svelte) and styling solution (UnoCSS/Tailwind/CSS).',
  inputSchema: {
    workspaceDir: z.string().min(1).describe('Absolute path to the real frontend project root'),
  },
}, async ({ workspaceDir }) => {
  const workspace = resolveWorkspaceDir(workspaceDir);
  const { detectWorkspace } = await import('./adapters/figma/shared.js');
  const detected = detectWorkspace(workspace);
  return jsonResponse(detected);
});

server.registerTool('figma_get_node_style', {
  title: 'Get Figma node style, CSS declarations, and utility classes',
  description: 'Return normalized style data, standard CSS property declarations, and framework-adaptive utility classes (UnoCSS/Tailwind) for a node in a Figma file.',
  inputSchema: {
    url: z.string().min(1).describe('Figma design URL or fileKey'),
    node: z.string().min(1).describe('Figma node ID, e.g. 1:2 or 1-2'),
    styleType: z.enum(['auto', 'unocss', 'tailwind', 'css']).default('auto').describe('Styling engine: auto (detect from project workspace), unocss, tailwind, or standard css declarations'),
    workspaceDir: z.string().optional().describe('Optional absolute path to the real frontend project root for auto-detecting framework & styling'),
    token: z.string().optional().describe('Optional Figma Personal Access Token'),
  },
}, async ({ url, node, styleType, workspaceDir, token }) => {
  const args = [url, '--node', node, '--style-type', styleType || 'auto'];
  optionalStringArg(args, '--workspace', workspaceDir);
  optionalStringArg(args, '--token', token);
  const result = await runOpenCli('style', args);
  return jsonResponse(result);
});

server.registerTool('figma_get_tree', {
  title: 'Get Figma layer tree with adaptive styles',
  description: 'Return the full Figma layer tree, optionally including normalized style data, CSS declarations, and framework-adaptive classes for every node.',
  inputSchema: {
    url: z.string().min(1).describe('Figma design URL or fileKey'),
    frame: z.string().optional().describe('Optional frame/page ID filter (e.g. 1:2)'),
    withStyle: z.boolean().default(false).describe('Include normalized style data, CSS declarations, and adaptive classes for every node'),
    styleType: z.enum(['auto', 'unocss', 'tailwind', 'css']).default('auto').describe('Styling engine: auto, unocss, tailwind, or standard css declarations'),
    workspaceDir: z.string().optional().describe('Optional absolute path to the real frontend project root for auto-detecting framework & styling'),
    maxDepth: z.number().int().min(0).default(99).describe('Maximum child depth to include'),
    token: z.string().optional().describe('Optional Figma Personal Access Token'),
  },
}, async ({ url, frame, withStyle, styleType, workspaceDir, maxDepth, token }) => {
  const args = [url, '--max-depth', String(maxDepth ?? 99), '--style-type', styleType || 'auto'];
  optionalStringArg(args, '--frame', frame);
  optionalStringArg(args, '--workspace', workspaceDir);
  optionalStringArg(args, '--token', token);
  if (withStyle) args.push('--with-style');
  const result = await runOpenCli('tree', args, { timeoutMs: 180_000 });
  return jsonResponse(result);
});

server.registerTool('figma_extract_tokens', {
  title: 'Extract Figma design tokens',
  description: 'Extract reusable design tokens (colors, fontSizes, fontWeights, radii, spacing) from a Figma design URL.',
  inputSchema: {
    url: z.string().min(1).describe('Figma design URL or fileKey'),
    token: z.string().optional().describe('Optional Figma Personal Access Token'),
  },
}, async ({ url, token }) => {
  const args = [url];
  optionalStringArg(args, '--token', token);
  const result = await runOpenCli('tokens', args);
  return jsonResponse(result);
});

server.registerTool('figma_download_asset', {
  title: 'Download Figma asset',
  description: 'Download SVG/PNG/JPG renders or image fills from a specific Figma node ID.',
  inputSchema: {
    url: z.string().min(1).describe('Figma design URL or fileKey'),
    node: z.string().min(1).describe('Figma node ID, e.g. 1:2 or 1-2'),
    type: z.enum(['svg', 'png', 'jpg', 'pdf', 'image']).default('png').describe('Asset format: svg, png, jpg, pdf, or image fill'),
    scale: z.number().min(0.5).max(4).default(2).describe('Render scale multiplier (e.g. 1, 2, 3)'),
    name: z.string().optional().describe('Custom filename for the downloaded file'),
    out: z.string().optional().describe('Output directory or absolute path to save the file. Defaults to current directory.'),
    token: z.string().optional().describe('Optional Figma Personal Access Token'),
  },
}, async ({ url, node, type, scale, name, out, token }) => {
  const args = [url, '--node', node, '--type', type || 'png', '--scale', String(scale || 2)];
  optionalStringArg(args, '--name', name);
  optionalStringArg(args, '--out', out);
  optionalStringArg(args, '--token', token);
  const result = await runOpenCli('asset', args);
  return jsonResponse(result);
});

server.registerTool('figma_sync_project', {
  title: 'Sync Figma project catalog',
  description: 'List Figma pages/frames/files and write a sanitized .figma-mcp/catalog.json into the real frontend workspace for fast reference.',
  inputSchema: {
    url: z.string().min(1).describe('Figma design or project URL'),
    workspaceDir: z.string().min(1).describe('Absolute path to the real frontend project root where .figma-mcp should be created'),
    name: z.string().optional().describe('Optional display name for this Figma source'),
    types: z.array(z.string()).optional().describe('Node types to include in catalog (e.g. ["frame", "page"]). Defaults to all.'),
    limit: z.number().int().min(1).max(2000).default(500).describe('Maximum items to return'),
    token: z.string().optional().describe('Optional Figma Personal Access Token'),
  },
}, async ({ url, workspaceDir, name, types, limit, token }) => {
  const workspace = resolveWorkspaceDir(workspaceDir);
  const catalogPath = catalogPathFor(workspace);
  const previous = await readWorkspaceCatalog(workspace);
  const previousIndex = indexPreviousDesigns(previous.designs);

  const pagesArgs = [url, '--limit', String(limit ?? 500)];
  optionalStringArg(pagesArgs, '--token', token);

  const pages = normalizePagesResult(await runOpenCli('pages', pagesArgs));
  const includeTypes = types === undefined ? [] : cleanStringList(types);
  const includeTypeSet = new Set(includeTypes.map((t) => t.toLowerCase()));
  const catalogPages = includeTypes.length > 0
    ? pages.filter((page) => includeTypeSet.has(cleanString(page.type).toLowerCase()))
    : pages;

  const now = new Date().toISOString();
  const cleanUrl = sanitizeUrl(url);
  const existingSources = Array.isArray(previous.sources) ? previous.sources : [];
  const sources = [
    ...existingSources.filter((source) => source?.url !== cleanUrl),
    {
      name: cleanString(name ?? 'Figma Source'),
      url: cleanUrl,
      lastSyncedAt: now,
    },
  ];

  const designs = catalogPages.map((page) => {
    const itemUrl = sanitizeUrl(page.url ?? '');
    const previousDesign = previousIndex.get(page.id)
      ?? previousIndex.get(itemUrl)
      ?? previousIndex.get(page.name);
    return normalizeCatalogDesign(page, previousDesign, now);
  }).filter((design) => design.url && design.name);

  const catalog = {
    version: 1,
    updatedAt: now,
    sources,
    designs,
  };

  await writeJsonFile(catalogPath, catalog);
  const aliasesPath = aliasesPathFor(workspace);
  const aliasesCreated = await ensureJsonFile(aliasesPath, {});

  return jsonResponse({
    workspaceDir: workspace,
    catalogPath,
    aliasesPath,
    aliasesCreated,
    includeTypes,
    scannedCount: pages.length,
    designCount: designs.length,
    sourceCount: sources.length,
    designs: designs.map(designSummary),
  });
});

server.registerTool('figma_search_designs', {
  title: 'Search workspace Figma designs',
  description: 'Search the real frontend workspace .figma-mcp catalog by design/frame name, ID, URL, aliases, or tags.',
  inputSchema: {
    query: z.string().min(1).describe('Frame name, design title, alias, tag, URL, ID, or frontend file path to search for'),
    workspaceDir: z.string().min(1).describe('Absolute path to the real frontend project root containing .figma-mcp/catalog.json'),
    limit: z.number().int().min(1).max(100).default(20).describe('Maximum matches to return'),
  },
}, async ({ query, workspaceDir, limit }) => {
  const workspace = resolveWorkspaceDir(workspaceDir);
  const catalog = await readWorkspaceCatalog(workspace);
  const aliases = await readWorkspaceAliases(workspace);
  const matches = searchCatalog(catalog, aliases, query).slice(0, limit ?? 20);

  return jsonResponse({
    workspaceDir: workspace,
    catalogPath: catalogPathFor(workspace),
    aliasesPath: aliasesPathFor(workspace),
    query: cleanString(query),
    matches,
  });
});

server.registerTool('figma_get_tree_by_name', {
  title: 'Get Figma tree by workspace design name',
  description: 'Resolve a design/frame from the real frontend workspace .figma-mcp catalog, then return its Figma layer tree with framework-adaptive styles.',
  inputSchema: {
    name: z.string().min(1).describe('Design/frame name, alias, tag, URL, ID, or frontend file path to search for'),
    workspaceDir: z.string().min(1).describe('Absolute path to the real frontend project root containing .figma-mcp/catalog.json'),
    withStyle: z.boolean().default(true).describe('Include normalized style data, CSS declarations, and adaptive classes for every node'),
    styleType: z.enum(['auto', 'unocss', 'tailwind', 'css']).default('auto').describe('Styling engine: auto (detect from workspace), unocss, tailwind, or standard css declarations'),
    maxDepth: z.number().int().min(0).default(99).describe('Maximum child depth to include'),
    token: z.string().optional().describe('Optional Figma Personal Access Token'),
  },
}, async ({ name, workspaceDir, withStyle, styleType, maxDepth, token }) => {
  const workspace = resolveWorkspaceDir(workspaceDir);
  const catalog = await readWorkspaceCatalog(workspace);
  const aliases = await readWorkspaceAliases(workspace);
  const matches = searchCatalog(catalog, aliases, name);

  if (matches.length !== 1) {
    return jsonResponse({
      status: matches.length === 0 ? 'not_found' : 'ambiguous',
      workspaceDir: workspace,
      catalogPath: catalogPathFor(workspace),
      query: cleanString(name),
      matches: matches.slice(0, 20),
    });
  }

  const design = matches[0];
  const args = [
    design.url,
    '--max-depth', String(maxDepth ?? 99),
    '--style-type', styleType || 'auto',
    '--workspace', workspace,
  ];
  if (withStyle ?? true) args.push('--with-style');
  optionalStringArg(args, '--token', token);
  const tree = await runOpenCli('tree', args, { timeoutMs: 180_000 });

  return jsonResponse({
    status: 'ok',
    workspaceDir: workspace,
    design: designSummary(design),
    tree,
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
