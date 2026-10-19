# Bxure Log MCP

通过 **TypeScript + Playwright + 本地 STDIO MCP** 操作 Bxure 日志平台。输入普通文本关键字和时间范围，返回可追溯的日志证据，由 Codex / Claude Code 结合当前代码分析。服务自身无需大模型 API Key。

当前版本：**v0.1.0 · 单环境版本**。每个 MCP 进程连接配置中的一个日志环境，支持该环境下的多个服务实例。切换环境需修改本地配置并重启进程；本版本不提供运行时环境切换或多环境聚合查询。详见 [版本说明](docs/releases/v0.1.0.md) 和 [变更记录](CHANGELOG.md)。

## 安装和首次使用

需要 Node.js 22+。在项目目录执行：

```powershell
npm ci
npx playwright install chromium
npm run build
Copy-Item config.example.json config.local.json
$env:BXURE_CONFIG = (Resolve-Path config.local.json).Path
$env:BXURE_PROFILE = 'codex'
npm run login
```

程序打开专用可见浏览器。在里面手动登录，并创建或导入 `Pre` 项目，然后进入日志页。完成后在终端按 Enter，关闭浏览器。项目初始化可能保存在 **IndexedDB** 中，专用浏览器 profile 会保留它以及登录状态。下次调用 MCP 继续复用。

本次开发时已经将手动初始化的浏览器状态保存到本机 `.bxure/bootstrap.json`，包含 IndexedDB。新 profile 首次启动会自动导入此文件，并写入 `.bootstrap-imported` 标记；之后以 profile 自己的数据为准，不覆盖后续登录状态。这个文件不会随源码分发；换机器时仍需首次手动初始化。

`npm start` 启动 STDIO 服务后等待客户端消息，没有普通交互界面。日常使用应让 MCP 客户端启动它。登录状态过期时，调用 `open_log_platform`，在打开的浏览器中重新完成初始化。

## 能力

| 工具 | 用途 |
| --- | --- |
| `open_log_platform` | 打开浏览器，报告是否需要人工登录或项目初始化 |
| `list_instances` | 列出 configurator / gateway / runner 实例 |
| `search_logs` | 按关键字、时间和实例检索；达到已知上限时自动拆分时间范围 |
| `preview_log` | 读取页面预览的可见内容，明确标记不完整 |
| `download_log` | 下载完整日志到本地，返回缓存位置及行数 |
| `find_in_download` | 在完整文件中搜索 traceId、异常类、业务标识，返回真实行号 |
| `read_log_context` | 读取指定行的前后文，在边界处补查同实例相邻编号文件 |

默认查询全部 runner 实例、平台时区最近 30 分钟。时间参数格式为 `YYYY-MM-DD HH:mm:ss`，**开始包含、结束不包含**；默认时区 `Asia/Shanghai`。`instances` 可指定多个完整实例名，否则通过 `service` 选择服务类别。

例如告诉客户端：

> 使用 bxure-log 查 Pre 的 runner，2026-10-19 13:30:00 到 13:35:00 包含“城市”的日志。先给出证据；预览不足时下载并补查前后文件，结合当前项目代码分析。区分已确认事实和原因假设。

推荐顺序：`open_log_platform` → `list_instances` → `search_logs` → `preview_log` → `read_log_context`。从完整日志提取 traceId 后，可再次 `search_logs` 查询其他文件及实例。

## 下载认证

下载凭据与平台首次登录分开设置。认证来源限定到 `BXURE_DOWNLOAD_ORIGIN` 的完整 origin（协议、域名、可选端口），防止将下载凭据提供给其他站点。不要在聊天或 MCP 工具参数中输入密码。

可以在本机创建被 Git 忽略的 `.env`：

```dotenv
BXURE_CONFIG=D:/Ben/GitHub/bxure-log-mcp/config.local.json
BXURE_PROFILE=codex
BXURE_DOWNLOAD_ORIGIN=https://your-download-host.example.com
BXURE_DOWNLOAD_USERNAME=your-username
BXURE_DOWNLOAD_PASSWORD="your-password"
```

将 origin 改为真实下载站点；工具遇到认证拒绝时会报告该 origin。密码包含 `#`、空格时请使用引号；特殊引号请按 Node 的 env 文件格式处理。`.env` **不会自动加载**，通过 Node `--env-file` 显式加载：

```powershell
node --env-file=.env dist/index.js
```

也可从客户端进程继承以上环境变量。认证配置变更后需要重启 MCP，浏览器启动时才会设置 `httpCredentials`。

## 接入 Codex

将以下配置合并到 `~/.codex/config.toml`。路径按实际安装位置调整，使用绝对路径，避免受当前代码仓库影响。示例读取本地 `.env`，不在客户端配置中复制密码。

```toml
[mcp_servers.bxure_log]
command = "node"
args = ["--env-file=D:/Ben/GitHub/bxure-log-mcp/.env", "D:/Ben/GitHub/bxure-log-mcp/dist/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 300

[mcp_servers.bxure_log.env]
BXURE_PROFILE = "codex"
```

确认 `.env` 和 `config.local.json` 存在，已执行 `npm run build`。重新连接 MCP 后，确认出现上述 7 个工具。客户端连接浏览器可能需要运行环境允许启动本地子进程及访问日志站点。

配置字段依据 [OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp/)。本项目提供配置示例，不自动修改用户全局设置。

## 接入 IDEA 中的 Claude Code

在使用官方 Claude Code 插件的项目中合并以下 `.mcp.json` 配置；使用相同源码及独立的 `claude` profile。

```json
{
  "mcpServers": {
    "bxure-log": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--env-file=D:/Ben/GitHub/bxure-log-mcp/.env",
        "D:/Ben/GitHub/bxure-log-mcp/dist/index.js"
      ],
      "env": { "BXURE_PROFILE": "claude" }
    }
  }
}
```

首次连接后用 `/mcp` 查看工具状态。Codex 与 Claude Code 同时运行时必须使用不同 profile，同一个 Chromium profile 不能被多个进程同时占用。见 [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp) 和 [JetBrains 集成文档](https://code.claude.com/docs/en/jetbrains)。

## 完整性与边界

- **平台结果上限还未确认。** 实际整天查询观察到 20 行，但这不足以证明固定上限。默认 `resultLimit: null`，返回 `completeness: "unconfirmed"`。在确认规则后配置 `resultLimit`，或配置经过验证的 `selectors.limitIndicator`；达到上限会递归拆分为相接的半开时间片。
- `complete` 只表示按已配置的平台上限规则完成表格检索，**不代表文件内每个匹配均已列出**。使用 `find_in_download` 检查完整文件。达到 `maxQueries`、`maxHits` 或最小时间片仍有上限时，`unresolved` 会列出未证实完整的范围。
- 真实预览为 Monaco 虚拟编辑器，只返回当前可见文本，不能用于确认完整异常栈或真实行号。完整文件才提供真实行号。
- 仅按同实例、同日期目录下文件末尾数字推导前后文件，例如 `2026-10-19/console.612.log` → `console.611.log` / `console.613.log`。不猜测跨日期轮转规则。
- 只有发现的下载 URL 能按原文件路径替换时，才补查相邻文件；未知 URL 规则会报告 `ADJACENT_URL_UNKNOWN`。跨文件返回独立片段和边界时间检查；缺时间戳、倒序或大间隔均标为未验证。编号相邻不证明属于同一调用。
- `maxFileBytes` 默认 20 MB。文本默认 UTF-8，可配置 `gb18030` 等 Node TextDecoder 支持的编码。检索返回正文受 `maxChars` 限制，并报告 `textTruncated`；`read_log_context` 优先保留中心行，再扩展前后文，超出 `maxChars` 时报告 `truncated`。
- 命中 ID 只在当前 MCP 进程有效，最多保留 5000 个。下载在当前进程内按实例及文件复用；重新搜索生成相同 ID 的命中后，日志仍可能处于增长状态，需重新启动进程刷新缓存。
- 日志原文可能含业务敏感信息，工具返回给当前客户端后由客户端模型分析。浏览器 profile、初始化状态、下载文件和 `.env` 均留在被 Git 忽略的本地目录中；不要手动提交这些文件。

## 配置和开发

`BXURE_CONFIG` 指向 JSON 文件；未设置时使用内置默认值。`BXURE_PROFILE` 优先于文件内的 `profile`。`dataDir` 相对项目安装目录解析，默认为 `.bxure`，不依赖调用方工作目录。页面选择器集中在 `config.example.json`，平台升级后可本地覆盖。

```powershell
npm run check
npm test
npm run test:browser
npm run test:stdio
npm run build
```

`npm test` 包括 MCP 握手、输入校验、时间拆分、上限及预算、跨实例去重、相邻文件和上下文测试。`test:browser` 使用真实 Chromium 及本地模拟站点，验证 iframe、异步查询、预览、Basic 认证、附件下载和相邻文件，不请求线上平台。

显式运行只读线上联调（输出摘要，不打印日志正文或凭据）：

```powershell
$env:BXURE_SMOKE_START = '2026-10-19 13:30:00'
$env:BXURE_SMOKE_END = '2026-10-19 13:35:00'
$env:BXURE_SMOKE_KEYWORD = '城市'
node --env-file=.env --import tsx scripts/smoke-live.ts
# 同时验证真实下载（需要先配置下载认证）
$env:BXURE_SMOKE_DOWNLOAD = '1'
node --env-file=.env --import tsx scripts/smoke-live.ts
```

2026-10-19 已验证真实平台初始化状态恢复、3 个实例、时间选择器、关键字检索、预览、HTTP 认证下载和前后相邻文件补查。实际命中文件下载得到 24,310 行；前后两个文件均补查成功，边界时间差为 1 ms 和 3 ms，无缺失上下文警告。本地模拟站点的认证下载与跨文件测试也已通过。平台结果上限仍未确认，检索完整性保持保守标记。

核心文件：`browser.ts` 处理网页，`core.ts` 处理拆分与文件编号，`service.ts` 组织证据及本地上下文，`server.ts` 注册 MCP 工具并串行化浏览器操作。STDIO stdout 仅传 MCP 数据，启动错误输出到 stderr。
