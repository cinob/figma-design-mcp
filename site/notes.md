# Figma OpenCLI & MCP Toolchain Notes

## 架构

```text
Claude Code / Cursor / AI Agent
       |
       | MCP Tool: figma_get_node_style / figma_get_tree
       v
figma-design-mcp (server.js)
       |
       | 执行: opencli figma <command> ... -f json
       v
OpenCLI Figma Adapters (~/.opencli/clis/figma/*.js)
       |
       | Token (环境变量/参数/本地文件) 或 浏览器登录态
       v
Figma REST API (api.figma.com/v1) & CDN
```

## Figma 认证策略

1. **Personal Access Token (PAT)**
   - 环境变量：`FIGMA_TOKEN` 或 `FIGMA_ACCESS_TOKEN`
   - 本地配置文件：`~/.figma/token` 或 项目目录 `.env`
   - 命令行参数：`--token <token>`
   - 获取方式：Figma 网页 -> 头像 -> Settings -> Security -> Personal access tokens
2. **浏览器登录态**
   - 结合 OpenCLI 的 `Strategy.COOKIE`，可从已登录的 Chrome 标签页提取会话与 token。

## URL 格式支持

- 文件或画板：`https://www.figma.com/design/:fileKey/:title?node-id=:nodeId`
- 旧版文件：`https://www.figma.com/file/:fileKey/:title?node-id=:nodeId`
- FigJam：`https://www.figma.com/board/:fileKey/:title?node-id=:nodeId`
- 项目：`https://www.figma.com/files/project/:projectId`
- 纯 key：`abc123xyz456...`

## 节点 ID 转换

Figma Web URL 中通常将冒号编码为减号（如 `node-id=101-205`），而在 Figma REST API 中标准格式为冒号（如 `101:205`）。本适配器会在输入层自动进行双向兼容与标准化。
