# Figma Design MCP

从 Figma 设计稿提取前端样式、设计 Token、图层树和导出切图的本地工具链，基于 [OpenCLI](https://github.com/jackwener/opencli) 适配器实现，提供专为 Claude Code、Cursor 和 AI Agent 打造的 MCP 插件服务。

## 功能特性

- **工作区自适应与无死锁技术栈绑定**：自动探测宿主前端工程的 `package.json` 与配置文件，智能自适应当前工程的框架（Vue 3、Nuxt、React、Next.js、uni-app、Svelte 等）与样式引擎（UnoCSS、Tailwind CSS 或标准 CSS）。
- **通用标准 CSS 声明输出 (`css`)**：为每一个节点提供框架无关的标准 CSS 属性键值对字典（`display`, `flex-direction`, `gap`, `padding`, `border-radius`, `box-shadow` 等），任何 CSS/SCSS/LESS/CSS Modules 或原生内联样式均可开箱即用。
- **自适应 Utility 实用类 (`classes`)**：根据目标工程的样式方案自动生成最契合的类名列表（Tailwind 任意值规范 `gap-[20px]`，或 UnoCSS 标度规范 `gap-20px`）。
- **设计稿元数据解析**：快速获取 Figma 文件的标题、画框列表、页面数量及更新时间。
- **页面与画框检索**：一览文件内的 Page (Canvas) 和顶级 Frame，或列出 Figma 项目下的所有文件。
- **图层结构树提取**：导出完整或指定深度的图层树，支持挂载节点计算样式、标准 CSS 声明与文本内容。
- **设计 Token 提取**：自动聚合并去重设计稿中的颜色色板、字号阶梯、字重列表、圆角规格以及常用间距。
- **资源与切图下载**：通过 Figma API 直接导出指定节点的 SVG 矢量文件、PNG/JPG 位图（支持自定义缩放倍数）或提取图片填充原图。
- **本地项目索引工作流**：支持将设计稿结构同步为前端工程下的 `.figma-mcp/catalog.json`，方便通过名称直接搜索和还原设计稿。

## OpenCLI 命令一览

```bash
# 1. 设计稿元数据（标题、页面数、画框数）
opencli figma design <url> -f json

# 2. 页面/文件/画框列表
opencli figma pages <url> -f json

# 3. 扁平图层列表（ID、名称、类型、位置尺寸）
opencli figma layers <url> --frame "1:2" --limit 50 -f json

# 4. 单个节点的样式与 UnoCSS 实用类
opencli figma style <url> --node "1:2" -f json

# 5. 完整图层树（包含每个节点的样式与 UnoCSS 类）
opencli figma tree <url> --with-style -f json

# 6. 提取设计 Token（颜色、字号、圆角、间距等）
opencli figma tokens <url> -f json

# 7. 下载节点切图或矢量素材 (支持 svg / png / jpg / image)
opencli figma asset <url> --node "1:2" --type svg --out ./assets -f json
```

## 安装与配置

### 1. 安装依赖与链接适配器

```bash
cd figma-design-mcp
pnpm install     # postinstall 会自动创建符号链接到 ~/.opencli/clis/figma/
pnpm run status  # 查看链接状态
```

也可以使用 `npm install`。

### 2. 配置 Figma 访问凭证 (Token)

本插件采用 `Strategy.PUBLIC` 纯 HTTP API 架构，完全无需启动 Chrome 浏览器，秒级极速响应。

支持多种凭证获取方式（按优先级降序）：

1. **命令行参数**：`--token <your_token>`
2. **环境变量**：设置 `FIGMA_TOKEN` 或 `FIGMA_ACCESS_TOKEN`（推荐在 `~/.bashrc`、`~/.zshrc` 或当前前端项目 `.env` 中配置）
3. **本地文件**：保存在 `~/.figma/token` 中

> **如何获取 Figma Personal Access Token**：
> 1. 打开 Figma 并在右上角点击头像 -> **Settings**（或直接访问 `https://www.figma.com/settings`）。
> 2. 进入 **Security** 标签页，找到 **Personal access tokens**。
> 3. 点击 **Generate new token**，名称随意填写并复制生成的 Token。

## 工作原理

```text
Claude Code / AI Agent
       |
       | MCP Tool: figma_get_node_style / figma_get_tree
       v
figma-design-mcp (server.js)
       |
       | 调用: opencli figma <command> ... -f json
       v
OpenCLI Figma Adapters (Strategy.PUBLIC, 纯 HTTP 架构)
       |
       | 自动解析 URL 中的 fileKey 与 nodeId
       | 读取 FIGMA_TOKEN (零浏览器开销、无头运行)
       v
Figma REST API (api.figma.com/v1) & CDN
       |
       | 返回原始文件 AST、节点属性、样式树
       v
样式标准化与 UnoCSS 映射引擎 -> 结构化 JSON 响应
```

## 项目结构

```text
figma-design-mcp/
├── package.json              # 依赖 @jackwener/opencli、MCP SDK、zod
├── server.js                 # MCP stdio server，薄封装 opencli figma 命令
├── sync-adapters.sh          # 符号链接同步管理脚本
├── CLAUDE.md                 # 架构与命令参考
├── README.md                 # 使用指南
├── adapters/figma/           # OpenCLI Figma 适配器源码
│   ├── shared.js             # API 请求、Token 获取、颜色/样式解析与 UnoCSS 转换
│   ├── design.js             # figma design 命令
│   ├── pages.js              # figma pages 命令
│   ├── layers.js             # figma layers 命令
│   ├── style.js              # figma style 命令
│   ├── tree.js               # figma tree 命令
│   ├── tokens.js             # figma tokens 命令
│   └── asset.js              # figma asset 命令
└── site/                     # 验证 fixtures 与说明文档
    ├── notes.md
    └── verify/
```

适配器通过符号链接映射到 `~/.opencli/clis/figma/`，修改 `adapters/figma/` 中的源码会立即生效。

## 常用脚本

```bash
./sync-adapters.sh link      # 创建符号链接
./sync-adapters.sh unlink    # 移除符号链接
./sync-adapters.sh status    # 查看当前状态

pnpm run link
pnpm run unlink
pnpm run status
pnpm run check               # 检查 MCP server 语法
pnpm run mcp                 # 以 stdio 方式启动 MCP server
```

## 在 Claude Code 中接入 MCP

在 Claude Code 中添加项目级或全局 MCP 服务：

```bash
claude mcp add -s project figma -- node /path/to/figma-design-mcp/server.js
```

查看或管理：

```bash
claude mcp list
claude mcp get figma
claude mcp remove figma
```

### 暴露的 MCP 工具

- `figma_get_design`: 获取设计稿元数据（标题、修改时间、页面数、画框数）。
- `figma_list_pages`: 列出 Figma 文件中的页面/画框，或项目下的文件。
- `figma_list_layers`: 列出指定画框或页面下的图层列表。
- `figma_get_node_style`: 获取单个节点的精细样式（包含排版、色彩、圆角、阴影、自动布局和 UnoCSS 实用类）。
- `figma_get_tree`: 获取完整或指定深度的图层树（可包含样式与 UnoCSS 类）。
- `figma_extract_tokens`: 提取设计系统 Token（色板、字号、圆角、间距）。
- `figma_download_asset`: 下载指定节点的切图、SVG 矢量图、PNG 位图或原图填充。
- `figma_sync_project`: 将 Figma 页面索引同步写入前端工作区的 `.figma-mcp/catalog.json`。
- `figma_search_designs`: 在前端工作区搜索设计稿或画框。
- `figma_get_tree_by_name`: 根据设计稿或画框名称直接检索并获取对应的图层树。

## Claude Code 推荐前端还原工作流

1. **项目目录索引同步**：
   在前端工程根目录下，调用 `figma_sync_project`，传入 Figma 设计稿链接与工作区绝对路径 `workspaceDir`。将自动生成 `.figma-mcp/catalog.json` 与 `.figma-mcp/aliases.json`。
2. **检索目标设计稿**：
   通过 `figma_search_designs` 或 `figma_get_tree_by_name`，按页面名称（如“个人中心”、“登录卡片”）直接定位画框。
3. **获取结构与样式**：
   获取到的节点数据中已包含结构、文本内容、Auto-layout 弹性布局参数以及预先计算好的 `unocss` 类名。
4. **高质量代码生成**：
   Claude Code 结合前端技术栈（如 Vue 3 + UnoCSS + VueUse），以高还原度生成组件代码，无需手动丈量像素尺寸或换算十六进制色值。
5. **下载矢量图标与切图**：
   通过 `figma_download_asset`，指定对应图标或配图的 node ID，直接将 SVG/PNG 保存到前端工程的 `assets/` 目录中。
