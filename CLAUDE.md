# Figma Design MCP Project

## Project Goal

Build a local toolchain that helps Claude Code extract usable frontend styling information, design tokens, layer trees, and asset exports from Figma design pages, then use that information to reproduce UI accurately in frontend code.

The toolchain is **framework-agnostic and project-adaptive**:
- Automatically inspects the target frontend workspace to detect its framework (Vue, Nuxt, React, Next.js, uni-app, Svelte) and styling solution (UnoCSS, Tailwind CSS, or standard CSS/SCSS).
- Emits universal CSS declaration dictionaries (`css`), adaptive utility class arrays (`classes`), and structured design tokens.
- Works across any frontend project without hardcoding one fixed tech stack.

The architecture is OpenCLI-first:

```text
Figma Page / REST API
  -> OpenCLI Figma adapter
  -> structured JSON design/style/token output + UnoCSS classes
  -> thin MCP server wrapper
  -> Claude Code / Cursor / other MCP clients
```

## Recommended Architecture

```text
Claude Code
   |
   | MCP tool: figma_get_node_style / figma_get_tree
   v
figma-mcp-server
   |
   | runs: opencli figma <command> ... -f json
   v
OpenCLI Figma Adapter (Strategy.PUBLIC, pure HTTP)
   |
   | Personal Access Token (FIGMA_TOKEN / ~/.figma/token)
   v
Figma REST API & CDN
```

The MCP server is a thin wrapper around OpenCLI commands. Token resolution, endpoint calls, data normalization, and UnoCSS utility mapping live in the OpenCLI layer. Zero browser overhead.

## Project Structure

```text
figma-design-mcp/
├── CLAUDE.md
├── README.md
├── package.json              # type: module, depends on @jackwener/opencli + MCP SDK
├── server.js                 # MCP stdio server, thin wrapper around OpenCLI
├── sync-adapters.sh          # link/unlink adapters via symlinks
├── adapters/figma/           # adapter source code (symlinked to ~/.opencli/clis/figma/)
│   ├── shared.js             # API client, URL parser, token resolution, style & UnoCSS generator
│   ├── design.js             # opencli figma design
│   ├── pages.js              # opencli figma pages
│   ├── layers.js             # opencli figma layers
│   ├── style.js              # opencli figma style
│   ├── tree.js               # opencli figma tree
│   ├── tokens.js             # opencli figma tokens
│   ├── asset.js              # opencli figma asset
│   └── comments.js           # opencli figma comments
└── site/                     # OpenCLI site memory & verification
    ├── notes.md              # Figma API & authentication notes
    └── verify/               # adapter verification fixtures
        ├── design.json
        ├── layers.json
        ├── style.json
        └── tokens.json
```

Adapters are symlinked to `~/.opencli/clis/figma/` so edits take effect immediately. Run `./sync-adapters.sh link` after cloning.

## Figma Authentication & Configuration

The adapter looks for a Figma Personal Access Token in the following order:

1. CLI argument: `--token <token>`
2. Environment variable: `FIGMA_TOKEN` or `FIGMA_ACCESS_TOKEN`
3. Local token file: `~/.figma/token` or project `.env`
4. Browser evaluation: if running via OpenCLI browser session and logged in to `figma.com`

To get a Personal Access Token:
- Go to Figma -> Account Settings -> Security -> Personal access tokens -> Generate new token.

## OpenCLI Commands

### `figma/design`

Purpose: open a Figma design URL and return design/page/frame metadata.

```bash
opencli figma design <url> -f json
```

Expected output shape:

```json
[
  {
    "title": "Mobile App Design System",
    "lastModified": "2026-10-20T10:00:00Z",
    "pageCount": 3,
    "frameCount": 12
  }
]
```

### `figma/pages`

Purpose: list pages/canvases/frames in a Figma file, or files in a Figma project.

```bash
opencli figma pages <url> -f json
```

### `figma/layers`

Purpose: return flattened layer data from a Figma design URL.

```bash
opencli figma layers <url> --frame 1:2 --limit 50 -f json
```

### `figma/style`

Purpose: return normalized style data (typography, colors, borders, layout, shadows) and generated UnoCSS classes for a specific node.

```bash
opencli figma style <url> --node 1:2 -f json
```

Expected output shape:

```json
[
  {
    "id": "1:2",
    "name": "Submit Button",
    "type": "FRAME",
    "bboxX": 20,
    "bboxY": 400,
    "bboxW": 335,
    "bboxH": 48,
    "background": "#1677ff",
    "color": "#ffffff",
    "fontSize": 16,
    "fontWeight": 600,
    "borderRadius": 8,
    "border": null,
    "boxShadow": "0px 4px 12px 0px rgba(22, 119, 255, 0.25)",
    "opacity": 1,
    "layout": {
      "mode": "row",
      "itemSpacing": 8,
      "padding": { "top": 12, "right": 16, "bottom": 12, "left": 16 },
      "alignItems": "center",
      "justifyContent": "center"
    },
    "unocss": [
      "flex",
      "gap-8px",
      "py-12px",
      "px-16px",
      "items-center",
      "justify-center",
      "rounded-8px",
      "bg-[#1677ff]",
      "text-[#ffffff]",
      "text-16px",
      "font-600"
    ]
  }
]
```

### `figma/tree`

Purpose: return the full Figma layer tree, optionally including normalized style data and UnoCSS classes for every node.

```bash
opencli figma tree <url> --with-style -f json
```

Use this as the primary input for UI reproduction.

### `figma/tokens`

Purpose: extract reusable design tokens (colors, fontSizes, fontWeights, radii, spacing) from a Figma design.

```bash
opencli figma tokens <url> -f json
```

### `figma/asset`

Purpose: download SVG/PNG/JPG renders or image fills from a specific Figma node.

```bash
opencli figma asset <url> --node 1:2 --type svg --out ./assets -f json
```

### `figma/comments`

Purpose: extract comments from a Figma design URL, including target node ID, relative pin offset, resolved status, and replies.

```bash
opencli figma comments <url> --node 1:2 --unresolved-only -f json
```

## MCP Tools

MCP server entrypoint: `server.js`. Install in Claude Code with:

```bash
claude mcp add -s project figma -- node ./server.js
```

Exposed tools:

- `figma_get_design`
- `figma_list_pages`
- `figma_list_layers`
- `figma_get_node_style`
- `figma_get_tree`
- `figma_extract_tokens`
- `figma_download_asset`
- `figma_get_comments`
- `figma_sync_project`
- `figma_search_designs`
- `figma_get_tree_by_name`

Each MCP tool calls the matching OpenCLI command and returns sanitized JSON.
