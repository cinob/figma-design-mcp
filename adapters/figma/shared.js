/**
 * Shared utilities for Figma adapters.
 * API-based and browser-based extraction using Figma's REST API and document tree.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const FIGMA_API_BASE = 'https://api.figma.com/v1';

/**
 * Parse a Figma URL to extract fileKey, nodeId, projectId, and title.
 * Formats:
 * - https://www.figma.com/design/:fileKey/:title?node-id=:nodeId
 * - https://www.figma.com/file/:fileKey/:title?node-id=:nodeId
 * - https://www.figma.com/board/:fileKey/:title?node-id=:nodeId
 * - https://www.figma.com/proto/:fileKey/:title?node-id=:nodeId
 * - https://www.figma.com/files/project/:projectId
 */
export function parseFigmaUrl(rawUrl) {
  if (!rawUrl) return null;
  const str = String(rawUrl).trim();

  // If input is purely a fileKey (alphanumeric, typically 22 chars)
  if (/^[a-zA-Z0-9_-]{18,30}$/.test(str)) {
    return {
      fileKey: str,
      nodeId: null,
      projectId: null,
      title: null,
    };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(str);
  } catch {
    // If not a full URL, attempt matching directly
    const keyMatch = str.match(/(?:design|file|board|proto)\/([a-zA-Z0-9_-]{18,30})/);
    if (keyMatch) {
      return {
        fileKey: keyMatch[1],
        nodeId: null,
        projectId: null,
        title: null,
      };
    }
    return null;
  }

  const pathname = parsedUrl.pathname;
  let fileKey = null;
  let title = null;
  let projectId = null;

  // Match /files/project/:projectId
  const projectMatch = pathname.match(/\/files\/project\/([a-zA-Z0-9_-]+)(?:\/([^/?#]+))?/);
  if (projectMatch) {
    projectId = projectMatch[1];
    title = projectMatch[2] ? decodeURIComponent(projectMatch[2]) : null;
  } else {
    // Match /design/:fileKey/:title or /file/:fileKey/:title or /board/:fileKey/:title
    const fileMatch = pathname.match(/\/(?:design|file|board|proto)\/([a-zA-Z0-9_-]+)(?:\/([^/?#]+))?/);
    if (fileMatch) {
      fileKey = fileMatch[1];
      title = fileMatch[2] ? decodeURIComponent(fileMatch[2]) : null;
    }
  }

  // Parse node-id from search params (e.g. ?node-id=1-2 or ?node-id=1:2)
  let nodeId = parsedUrl.searchParams.get('node-id') || parsedUrl.searchParams.get('node_id');
  if (nodeId) {
    nodeId = decodeURIComponent(nodeId);
    // Figma API uses ":" for node IDs (e.g. "1:2"), but URL frequently encodes it as "1-2"
    if (nodeId.includes('-') && !nodeId.includes(':')) {
      nodeId = nodeId.replace(/-/g, ':');
    }
  }

  return {
    fileKey,
    nodeId,
    projectId,
    title,
  };
}

/**
 * Read token from local filesystem fallback (~/.figma/token or .env)
 */
function readLocalToken() {
  try {
    const homeTokenPath = path.join(os.homedir(), '.figma', 'token');
    if (fs.existsSync(homeTokenPath)) {
      const token = fs.readFileSync(homeTokenPath, 'utf8').trim();
      if (token) return token;
    }
  } catch {}

  try {
    const cwdEnvPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(cwdEnvPath)) {
      const content = fs.readFileSync(cwdEnvPath, 'utf8');
      const match = content.match(/^FIGMA(?:_ACCESS)?_TOKEN\s*=\s*["']?([^"'\r\n]+)["']?/m);
      if (match && match[1]) return match[1].trim();
    }
  } catch {}

  return null;
}

/**
 * Retrieve Figma Personal Access Token.
 * Order of precedence:
 * 1. CLI args.token
 * 2. Environment variables (FIGMA_TOKEN, FIGMA_ACCESS_TOKEN, FIGMA_PERSONAL_ACCESS_TOKEN)
 * 3. Local token file (~/.figma/token or .env)
 */
export function getFigmaToken(cliArgs = {}) {
  // 1. Explicit arg
  if (cliArgs?.token && String(cliArgs.token).trim()) {
    return String(cliArgs.token).trim();
  }

  // 2. Env vars
  const envToken = process.env.FIGMA_TOKEN || process.env.FIGMA_ACCESS_TOKEN || process.env.FIGMA_PERSONAL_ACCESS_TOKEN;
  if (envToken && envToken.trim()) {
    return envToken.trim();
  }

  // 3. Local filesystem
  const localToken = readLocalToken();
  if (localToken) return localToken;

  throw new Error(
    'Figma Personal Access Token is required.\n' +
    'Please set the FIGMA_TOKEN environment variable (export FIGMA_TOKEN="..."),\n' +
    'save it in ~/.figma/token, or pass --token <token>.'
  );
}

/**
 * Make an authenticated API request to Figma REST API.
 * Pure HTTP, zero browser overhead.
 */
export async function figmaApi(pathWithQuery, options = {}, token = null) {
  const authToken = token || getFigmaToken();

  const url = `${FIGMA_API_BASE}${pathWithQuery}`;
  const headers = {
    'Accept': 'application/json',
    'X-Figma-Token': authToken,
    ...(options.headers || {}),
  };

  const resp = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
  });

  if (!resp.ok) {
    const errorBody = await resp.text().catch(() => '');
    let parsedErr = '';
    try {
      const j = JSON.parse(errorBody);
      parsedErr = j.message || j.err || errorBody;
    } catch {
      parsedErr = errorBody;
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Figma API authentication failed (${resp.status}): ${parsedErr}. Please check your FIGMA_TOKEN.`);
    }
    if (resp.status === 404) {
      throw new Error(`Figma resource not found (${resp.status}): ${parsedErr}. Please verify the file key and permissions.`);
    }
    if (resp.status === 429) {
      throw new Error(`Figma API rate limit exceeded (429). Please wait a moment before retrying.`);
    }
    throw new Error(`Figma API request failed (${resp.status} ${resp.statusText}): ${parsedErr.slice(0, 300)}`);
  }

  return await resp.json();
}

/**
 * Fetch a Figma file's document data.
 * Optional query params: depth, ids
 */
export async function fetchFigmaFile(fileKey, token, options = {}) {
  const params = new URLSearchParams();
  if (options.depth) params.set('depth', String(options.depth));
  if (options.ids) params.set('ids', Array.isArray(options.ids) ? options.ids.join(',') : options.ids);
  if (options.geometry) params.set('geometry', options.geometry);
  const query = params.toString() ? `?${params.toString()}` : '';
  return figmaApi(`/files/${fileKey}${query}`, {}, token);
}

/**
 * Fetch specific nodes from a Figma file.
 */
export async function fetchFigmaNodes(fileKey, nodeIds, token, options = {}) {
  const idsStr = Array.isArray(nodeIds) ? nodeIds.join(',') : nodeIds;
  const params = new URLSearchParams({ ids: idsStr });
  if (options.depth) params.set('depth', String(options.depth));
  if (options.geometry) params.set('geometry', options.geometry);
  return figmaApi(`/files/${fileKey}/nodes?${params.toString()}`, {}, token);
}

/**
 * Fetch image export URLs for specified node IDs.
 * Format can be 'png', 'svg', 'jpg', 'pdf'.
 */
export async function fetchFigmaImages(fileKey, nodeIds, token, options = {}) {
  const idsStr = Array.isArray(nodeIds) ? nodeIds.join(',') : nodeIds;
  const params = new URLSearchParams({
    ids: idsStr,
    format: options.format || 'png',
    scale: String(options.scale || 2),
  });
  if (options.svg_include_id) params.set('svg_include_id', 'true');
  return figmaApi(`/images/${fileKey}?${params.toString()}`, {}, token);
}

/**
 * Fetch image fills mapping (imageRef -> download URL).
 */
export async function fetchFigmaImageFills(fileKey, token) {
  return figmaApi(`/files/${fileKey}/images`, {}, token);
}

/**
 * Fetch files under a Figma project.
 */
export async function fetchProjectFiles(projectId, token) {
  return figmaApi(`/projects/${projectId}/files`, {}, token);
}

/**
 * Fetch comments for a Figma file.
 */
export async function fetchFigmaComments(fileKey, token) {
  return figmaApi(`/files/${fileKey}/comments`, {}, token);
}

/**
 * Recursively find a node by ID in the Figma tree.
 */
export function findFigmaNode(node, targetId) {
  if (!node || !targetId) return null;
  const normTarget = String(targetId).trim().replace(/-/g, ':');
  const normNodeId = String(node.id || '').trim().replace(/-/g, ':');

  if (normNodeId === normTarget) return node;

  for (const child of node.children || []) {
    const found = findFigmaNode(child, normTarget);
    if (found) return found;
  }
  return null;
}

/**
 * Recursively collect all nodes from a Figma node tree.
 */
export function collectFigmaNodes(node, depth = 0, maxDepth = 99) {
  if (!node) return [];
  const bbox = node.absoluteBoundingBox || node.absoluteRenderBounds;
  const result = [{
    id: String(node.id || ''),
    name: String(node.name || ''),
    type: String(node.type || ''),
    x: bbox ? Math.round(bbox.x) : 0,
    y: bbox ? Math.round(bbox.y) : 0,
    width: bbox ? Math.round(bbox.width) : 0,
    height: bbox ? Math.round(bbox.height) : 0,
    depth,
  }];

  if (depth < maxDepth && Array.isArray(node.children)) {
    for (const child of node.children) {
      result.push(...collectFigmaNodes(child, depth + 1, maxDepth));
    }
  }
  return result;
}

/**
 * Convert Figma color object { r: 0-1, g: 0-1, b: 0-1, a?: 0-1 } and opacity to CSS color.
 */
export function resolveFigmaColor(color, opacity = 1) {
  if (!color) return null;
  const r = Math.round(Math.min(255, Math.max(0, (color.r ?? 0) * 255)));
  const g = Math.round(Math.min(255, Math.max(0, (color.g ?? 0) * 255)));
  const b = Math.round(Math.min(255, Math.max(0, (color.b ?? 0) * 255)));
  const baseAlpha = color.a !== undefined ? color.a : 1;
  const finalAlpha = Math.min(1, Math.max(0, baseAlpha * (opacity !== undefined ? opacity : 1)));

  if (finalAlpha < 0.999) {
    return `rgba(${r}, ${g}, ${b}, ${Number(finalAlpha.toFixed(2))})`;
  }
  const hexR = r.toString(16).padStart(2, '0');
  const hexG = g.toString(16).padStart(2, '0');
  const hexB = b.toString(16).padStart(2, '0');
  return `#${hexR}${hexG}${hexB}`;
}

/**
 * Extract fill color/gradient/image description from a Figma fill.
 */
export function resolveFigmaFill(fill) {
  if (!fill || fill.visible === false) return null;
  const opacity = fill.opacity !== undefined ? fill.opacity : 1;

  if (fill.type === 'SOLID') {
    return resolveFigmaColor(fill.color, opacity);
  }

  if (fill.type === 'IMAGE') {
    return `image(${fill.imageRef || 'ref'})`;
  }

  if (fill.type === 'GRADIENT_LINEAR' && Array.isArray(fill.gradientStops)) {
    const stops = fill.gradientStops.map((s) => {
      const c = resolveFigmaColor(s.color, opacity);
      const pos = Math.round((s.position ?? 0) * 100);
      return `${c} ${pos}%`;
    }).join(', ');
    return `linear-gradient(${stops})`;
  }

  if (fill.type === 'GRADIENT_RADIAL' && Array.isArray(fill.gradientStops)) {
    const stops = fill.gradientStops.map((s) => {
      const c = resolveFigmaColor(s.color, opacity);
      const pos = Math.round((s.position ?? 0) * 100);
      return `${c} ${pos}%`;
    }).join(', ');
    return `radial-gradient(${stops})`;
  }

  return null;
}

/**
 * Extract CSS border from stroke properties.
 */
export function resolveFigmaStroke(strokes, strokeWeight) {
  if (!Array.isArray(strokes) || strokes.length === 0 || !strokeWeight) return null;
  const visibleStroke = strokes.find((s) => s.visible !== false);
  if (!visibleStroke) return null;
  const color = resolveFigmaFill(visibleStroke);
  if (!color) return null;
  return `${Math.round(strokeWeight)}px solid ${color}`;
}

/**
 * Extract CSS box-shadow from Figma effects.
 */
export function resolveFigmaShadow(effects) {
  if (!Array.isArray(effects) || effects.length === 0) return null;
  const shadows = effects
    .filter((e) => e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'))
    .map((e) => {
      const inset = e.type === 'INNER_SHADOW' ? 'inset ' : '';
      const x = Math.round(e.offset?.x || 0);
      const y = Math.round(e.offset?.y || 0);
      const radius = Math.round(e.radius || 0);
      const spread = Math.round(e.spread || 0);
      const color = resolveFigmaColor(e.color);
      return `${inset}${x}px ${y}px ${radius}px ${spread}px ${color || 'rgba(0,0,0,0.25)'}`;
    });

  return shadows.length > 0 ? shadows.join(', ') : null;
}

/**
 * Detect frontend framework and styling solution from the target project workspace.
 */
export function detectWorkspace(workspaceDir = process.cwd()) {
  const dir = path.resolve(workspaceDir);
  let pkg = {};
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    }
  } catch {}

  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  // 1. Detect styling engine
  let styleType = 'css';
  const hasUnoConfig = fs.existsSync(path.join(dir, 'uno.config.ts'))
    || fs.existsSync(path.join(dir, 'uno.config.js'))
    || fs.existsSync(path.join(dir, 'unocss.config.ts'))
    || fs.existsSync(path.join(dir, 'unocss.config.js'));
  const hasUnoDep = Object.keys(allDeps).some((d) => d.includes('unocss'));

  const hasTailwindConfig = fs.existsSync(path.join(dir, 'tailwind.config.js'))
    || fs.existsSync(path.join(dir, 'tailwind.config.ts'))
    || fs.existsSync(path.join(dir, 'tailwind.config.cjs'))
    || fs.existsSync(path.join(dir, 'tailwind.config.mjs'));
  const hasTailwindDep = Object.keys(allDeps).some((d) => d.includes('tailwindcss'));

  if (hasUnoConfig || hasUnoDep) {
    styleType = 'unocss';
  } else if (hasTailwindConfig || hasTailwindDep) {
    styleType = 'tailwind';
  }

  // 2. Detect frontend framework
  let framework = 'html';
  if (allDeps['@dcloudio/uni-app'] || allDeps['@dcloudio/uni-ui']) {
    framework = 'uni-app';
  } else if (allDeps['nuxt']) {
    framework = 'nuxt';
  } else if (allDeps['vue']) {
    framework = 'vue';
  } else if (allDeps['next'] || allDeps['react']) {
    framework = 'react';
  } else if (allDeps['svelte']) {
    framework = 'svelte';
  }

  return {
    workspaceDir: dir,
    styleType,
    framework,
    hasUno: styleType === 'unocss',
    hasTailwind: styleType === 'tailwind',
  };
}

function mapAlignItems(align) {
  switch (align) {
    case 'CENTER': return 'center';
    case 'MAX': return 'flex-end';
    case 'MIN': return 'flex-start';
    default: return 'stretch';
  }
}

function mapJustifyContent(justify) {
  switch (justify) {
    case 'CENTER': return 'center';
    case 'SPACE_BETWEEN': return 'space-between';
    case 'MAX': return 'flex-end';
    default: return 'flex-start';
  }
}

function generatePaddingClasses(padding, isTailwind = false) {
  const { top, right, bottom, left } = padding;
  const wrap = (val) => (isTailwind ? `[${val}px]` : `${val}px`);

  if (top === bottom && left === right && top === left && top > 0) {
    return [`p-${wrap(top)}`];
  }
  const result = [];
  if (top === bottom && top > 0) {
    result.push(`py-${wrap(top)}`);
  } else {
    if (top > 0) result.push(`pt-${wrap(top)}`);
    if (bottom > 0) result.push(`pb-${wrap(bottom)}`);
  }
  if (left === right && left > 0) {
    result.push(`px-${wrap(left)}`);
  } else {
    if (left > 0) result.push(`pl-${wrap(left)}`);
    if (right > 0) result.push(`pr-${wrap(right)}`);
  }
  return result;
}

/**
 * Generate standard CSS property-value declarations.
 * Framework-agnostic: works with standard CSS, inline styles, CSS modules, SCSS/LESS, or Vue/React.
 */
export function generateCssDeclarations(style, bbox, node) {
  const css = {};

  if (style.layout) {
    css.display = 'flex';
    css['flex-direction'] = style.layout.mode === 'column' ? 'column' : 'row';
    if (style.layout.itemSpacing > 0) {
      css.gap = `${style.layout.itemSpacing}px`;
    }

    const { top, right, bottom, left } = style.layout.padding;
    if (top === bottom && left === right && top === left && top > 0) {
      css.padding = `${top}px`;
    } else if (top === bottom && left === right && (top > 0 || left > 0)) {
      css.padding = `${top}px ${left}px`;
    } else if (top > 0 || right > 0 || bottom > 0 || left > 0) {
      css.padding = `${top}px ${right}px ${bottom}px ${left}px`;
    }

    if (style.layout.alignItems) css['align-items'] = style.layout.alignItems;
    if (style.layout.justifyContent) css['justify-content'] = style.layout.justifyContent;
  }

  if (style.borderRadius !== null && style.borderRadius !== undefined) {
    if (Array.isArray(style.borderRadius)) {
      css['border-radius'] = style.borderRadius.map((r) => `${r}px`).join(' ');
    } else if (style.borderRadius > 0) {
      css['border-radius'] = `${style.borderRadius}px`;
    }
  }

  if (style.background) css['background-color'] = style.background;
  if (style.color) css.color = style.color;
  if (style.fontSize) css['font-size'] = `${style.fontSize}px`;
  if (style.fontWeight) css['font-weight'] = style.fontWeight;
  if (style.fontFamily) css['font-family'] = style.fontFamily;
  if (style.lineHeight) css['line-height'] = `${style.lineHeight}px`;
  if (style.letterSpacing) css['letter-spacing'] = `${style.letterSpacing}px`;
  if (style.textAlign) css['text-align'] = style.textAlign;
  if (style.border) css.border = style.border;
  if (style.boxShadow) css['box-shadow'] = style.boxShadow;
  if (style.opacity !== null && style.opacity !== undefined && style.opacity < 1) {
    css.opacity = style.opacity;
  }

  return css;
}

/**
 * Generate utility classes based on the chosen styling engine (unocss, tailwind, or none).
 */
export function generateUtilityClasses(style, bbox, node, styleType = 'unocss') {
  if (styleType === 'css') {
    return [];
  }

  const isTailwind = styleType === 'tailwind';
  const wrap = (val) => (isTailwind ? `[${val}px]` : `${val}px`);
  const classes = [];

  if (style.layout) {
    classes.push('flex');
    if (style.layout.mode === 'column') classes.push('flex-col');
    if (style.layout.itemSpacing > 0) classes.push(`gap-${wrap(style.layout.itemSpacing)}`);

    classes.push(...generatePaddingClasses(style.layout.padding, isTailwind));

    if (style.layout.alignItems === 'center') classes.push('items-center');
    else if (style.layout.alignItems === 'flex-end') classes.push('items-end');

    if (style.layout.justifyContent === 'center') classes.push('justify-center');
    else if (style.layout.justifyContent === 'space-between') classes.push('justify-between');
    else if (style.layout.justifyContent === 'flex-end') classes.push('justify-end');
  }

  // Border radius
  if (typeof style.borderRadius === 'number' && style.borderRadius > 0) {
    if (style.borderRadius >= 999) classes.push('rounded-full');
    else classes.push(`rounded-${wrap(style.borderRadius)}`);
  }

  // Background
  if (style.background && style.background.startsWith('#')) {
    classes.push(`bg-[${style.background}]`);
  }

  // Text properties
  if (style.color && style.color.startsWith('#')) {
    classes.push(`text-[${style.color}]`);
  }
  if (style.fontSize) {
    classes.push(`text-${wrap(style.fontSize)}`);
  }
  if (style.fontWeight) {
    classes.push(isTailwind ? `font-[${style.fontWeight}]` : `font-${style.fontWeight}`);
  }
  if (style.textAlign === 'center') {
    classes.push('text-center');
  } else if (style.textAlign === 'right') {
    classes.push('text-right');
  }

  // Opacity
  if (style.opacity !== null && style.opacity < 1) {
    classes.push(`opacity-${Math.round(style.opacity * 100)}`);
  }

  return classes;
}

/**
 * Backward compatibility helper for UnoCSS classes.
 */
export function generateUnoClasses(style, bbox, node) {
  return generateUtilityClasses(style, bbox, node, 'unocss');
}

/**
 * Extract normalized style information from a raw Figma node.
 */
export function extractRawNodeStyle(node, options = {}) {
  if (!node) return {};
  const bbox = node.absoluteBoundingBox || node.absoluteRenderBounds;

  // Background fills
  let background = null;
  if (Array.isArray(node.fills) && node.fills.length > 0) {
    const visibleFill = node.fills.find((f) => f.visible !== false);
    if (visibleFill) background = resolveFigmaFill(visibleFill);
  }

  // Text color & typography
  let color = null;
  let fontSize = null;
  let fontWeight = null;
  let fontFamily = null;
  let lineHeight = null;
  let letterSpacing = null;
  let textAlign = null;

  if (node.type === 'TEXT') {
    if (Array.isArray(node.fills) && node.fills.length > 0) {
      const textFill = node.fills.find((f) => f.visible !== false);
      if (textFill) color = resolveFigmaFill(textFill);
    }
    background = null;

    if (node.style) {
      const s = node.style;
      fontSize = s.fontSize ? Math.round(s.fontSize) : null;
      fontWeight = s.fontWeight ? Math.round(s.fontWeight) : null;
      fontFamily = s.fontFamily || null;
      lineHeight = s.lineHeightPx ? Math.round(s.lineHeightPx) : null;
      letterSpacing = s.letterSpacing ? Number(s.letterSpacing.toFixed(1)) : null;
      textAlign = s.textAlignHorizontal ? s.textAlignHorizontal.toLowerCase() : null;
    }
  }

  // Border & radius
  const border = resolveFigmaStroke(node.strokes, node.strokeWeight);
  let borderRadius = null;
  if (node.cornerRadius !== undefined) {
    borderRadius = Math.round(node.cornerRadius);
  } else if (Array.isArray(node.rectangleCornerRadii)) {
    borderRadius = node.rectangleCornerRadii.map((r) => Math.round(r));
  }

  // Box shadow
  const boxShadow = resolveFigmaShadow(node.effects);

  // Opacity
  const opacity = node.opacity !== undefined ? Number(node.opacity.toFixed(2)) : null;

  // Layout (Auto-layout / Flexbox)
  let layout = null;
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    layout = {
      mode: node.layoutMode === 'HORIZONTAL' ? 'row' : 'column',
      itemSpacing: node.itemSpacing ? Math.round(node.itemSpacing) : 0,
      padding: {
        top: Math.round(node.paddingTop || 0),
        right: Math.round(node.paddingRight || 0),
        bottom: Math.round(node.paddingBottom || 0),
        left: Math.round(node.paddingLeft || 0),
      },
      alignItems: mapAlignItems(node.counterAxisAlignItems),
      justifyContent: mapJustifyContent(node.primaryAxisAlignItems),
    };
  }

  const baseStyle = {
    background,
    color,
    fontSize,
    fontWeight,
    fontFamily,
    lineHeight,
    letterSpacing,
    textAlign,
    borderRadius,
    border,
    boxShadow,
    opacity,
    layout,
  };

  // Resolve target styling engine
  let targetStyleType = options.styleType || 'auto';
  if (targetStyleType === 'auto') {
    const ws = detectWorkspace(options.workspaceDir);
    targetStyleType = ws.styleType;
  }

  const css = generateCssDeclarations(baseStyle, bbox, node);
  const classes = generateUtilityClasses(baseStyle, bbox, node, targetStyleType);

  return {
    ...baseStyle,
    css,
    classes,
    unocss: classes, // Alias for backward compatibility
  };
}

/**
 * Extract design metadata (title, pages/canvas, frames) from Figma file data.
 */
export function extractDesignMeta(fileData) {
  const document = fileData?.document || {};
  const pages = (document.children || []).filter((c) => c.type === 'CANVAS');

  const frames = [];
  for (const page of pages) {
    for (const child of page.children || []) {
      if (child.type === 'FRAME' || child.type === 'COMPONENT' || child.type === 'SECTION') {
        const bbox = child.absoluteBoundingBox || child.absoluteRenderBounds;
        frames.push({
          id: String(child.id || ''),
          name: String(child.name || 'Untitled Frame'),
          pageId: String(page.id || ''),
          pageName: String(page.name || 'Page'),
          type: child.type,
          width: bbox ? Math.round(bbox.width) : 0,
          height: bbox ? Math.round(bbox.height) : 0,
        });
      }
    }
  }

  return {
    title: String(fileData?.name || 'Untitled File'),
    lastModified: fileData?.lastModified || null,
    thumbnailUrl: fileData?.thumbnailUrl || null,
    version: fileData?.version || null,
    pageCount: pages.length,
    frameCount: frames.length,
    pages: pages.map((p) => ({
      id: String(p.id || ''),
      name: String(p.name || ''),
      frameCount: (p.children || []).filter((c) => c.type === 'FRAME' || c.type === 'COMPONENT').length,
    })),
    frames,
  };
}

/**
 * Extract flattened layers from Figma document.
 */
export function extractLayers(fileData, frameFilter = null, limit = 50) {
  const document = fileData?.document || {};
  const pages = (document.children || []).filter((c) => c.type === 'CANVAS');
  const allNodes = [];

  for (const page of pages) {
    if (frameFilter && page.id !== frameFilter) {
      // Check if frameFilter matches any frame inside this page
      const matchingChild = (page.children || []).find((c) => c.id === frameFilter || c.name === frameFilter);
      if (matchingChild) {
        allNodes.push(...collectFigmaNodes(matchingChild, 0));
        continue;
      }
    } else {
      allNodes.push(...collectFigmaNodes(page, 0));
    }
  }

  return allNodes.slice(0, limit).map((n) => ({
    id: String(n.id || ''),
    name: String(n.name || ''),
    type: String(n.type || ''),
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
  }));
}

/**
 * Extract style data for a specific node ID from Figma file data.
 */
export function extractNodeStyle(fileData, nodeId, options = {}) {
  const document = fileData?.document || {};
  const target = findFigmaNode(document, nodeId);
  if (!target) return [];

  const bbox = target.absoluteBoundingBox || target.absoluteRenderBounds;
  const style = extractRawNodeStyle(target, options);

  return [{
    id: String(target.id || ''),
    name: String(target.name || ''),
    type: String(target.type || ''),
    bboxX: bbox ? Math.round(bbox.x) : 0,
    bboxY: bbox ? Math.round(bbox.y) : 0,
    bboxW: bbox ? Math.round(bbox.width) : 0,
    bboxH: bbox ? Math.round(bbox.height) : 0,
    background: style.background,
    color: style.color,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    borderRadius: style.borderRadius,
    border: style.border,
    boxShadow: style.boxShadow,
    opacity: style.opacity,
    layout: style.layout,
    css: style.css,
    classes: style.classes,
    unocss: style.classes,
  }];
}

/**
 * Extract full or partial layer tree from Figma document.
 */
export function extractTree(rootNode, frameFilter = null, options = {}) {
  const withStyle = Boolean(options.withStyle);
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 99;

  function toNode(raw, depth = 0) {
    const bbox = raw.absoluteBoundingBox || raw.absoluteRenderBounds;
    const node = {
      id: String(raw.id || ''),
      name: String(raw.name || ''),
      type: String(raw.type || ''),
      x: bbox ? Math.round(bbox.x) : 0,
      y: bbox ? Math.round(bbox.y) : 0,
      width: bbox ? Math.round(bbox.width) : 0,
      height: bbox ? Math.round(bbox.height) : 0,
    };

    if (raw.type === 'TEXT' && raw.characters) {
      node.text = raw.characters;
    }

    if (withStyle) {
      const style = extractRawNodeStyle(raw, options);
      node.style = style;
      node.css = style.css;
      node.classes = style.classes;
      node.unocss = style.classes;
    }

    if (Array.isArray(raw.children) && raw.children.length > 0 && depth < maxDepth) {
      node.children = raw.children.map((child) => toNode(child, depth + 1));
    }
    return node;
  }

  const document = rootNode?.document || rootNode;
  const pages = (document.children || []).filter((c) => c.type === 'CANVAS');

  let targetRoots = pages.length > 0 ? pages : (document.children?.length ? document.children : [document]);
  if (frameFilter && pages.length > 0) {
    const normFilter = frameFilter.replace(/-/g, ':');
    // Try matching page id, frame id, or name
    let found = null;
    for (const page of pages) {
      if (page.id === normFilter || page.name === frameFilter) {
        targetRoots = [page];
        found = true;
        break;
      }
      const childMatch = findFigmaNode(page, normFilter);
      if (childMatch) {
        targetRoots = [childMatch];
        found = true;
        break;
      }
    }
  }

  return targetRoots.map((root) => toNode(root, 0));
}

/**
 * Extract reusable design tokens (colors, fontSizes, radii, spacing) from Figma document.
 */
export function extractTokens(fileData) {
  const colors = new Set();
  const fontSizes = new Set();
  const radii = new Set();
  const spacing = new Set();
  const fontWeights = new Set();

  function walk(node) {
    if (!node) return;

    // Collect fills
    if (Array.isArray(node.fills)) {
      for (const fill of node.fills) {
        const c = resolveFigmaFill(fill);
        if (c && c.startsWith('#')) colors.add(c);
      }
    }

    // Collect strokes
    if (Array.isArray(node.strokes)) {
      for (const stroke of node.strokes) {
        const c = resolveFigmaFill(stroke);
        if (c && c.startsWith('#')) colors.add(c);
      }
    }

    // Collect corner radius
    if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
      radii.add(Math.round(node.cornerRadius));
    } else if (Array.isArray(node.rectangleCornerRadii)) {
      for (const r of node.rectangleCornerRadii) {
        if (r > 0) radii.add(Math.round(r));
      }
    }

    // Collect auto-layout & position spacing
    if (node.itemSpacing && node.itemSpacing > 0) {
      spacing.add(Math.round(node.itemSpacing));
    }
    if (node.paddingTop && node.paddingTop > 0) spacing.add(Math.round(node.paddingTop));
    if (node.paddingBottom && node.paddingBottom > 0) spacing.add(Math.round(node.paddingBottom));
    if (node.paddingLeft && node.paddingLeft > 0) spacing.add(Math.round(node.paddingLeft));
    if (node.paddingRight && node.paddingRight > 0) spacing.add(Math.round(node.paddingRight));

    const bbox = node.absoluteBoundingBox || node.absoluteRenderBounds;
    if (bbox) {
      if (bbox.x > 0 && bbox.x < 500) spacing.add(Math.round(bbox.x));
      if (bbox.y > 0 && bbox.y < 500) spacing.add(Math.round(bbox.y));
    }

    // Collect typography
    if (node.type === 'TEXT' && node.style) {
      if (node.style.fontSize) fontSizes.add(Math.round(node.style.fontSize));
      if (node.style.fontWeight) fontWeights.add(Math.round(node.style.fontWeight));
    }

    for (const child of node.children || []) {
      walk(child);
    }
  }

  const document = fileData?.document || {};
  walk(document);

  return {
    colors: [...colors].sort(),
    fontSizes: [...fontSizes].sort((a, b) => a - b),
    fontWeights: [...fontWeights].sort((a, b) => a - b),
    radii: [...radii].sort((a, b) => a - b),
    spacing: [...spacing].sort((a, b) => a - b),
  };
}
