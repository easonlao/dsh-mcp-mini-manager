# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-13

首个版本。

### 新增

- 设置页「MCP 极简管理」（`settings.section` id `mcp-mini-manager`，order 16），与内置「插件」同级、紧接其后。
- 列出当前 DSH 实际装载的每个 MCP 服务器：名称、传输方式与 endpoint（stdio 命令行 / streamable-http URL）、运行状态、简介、以及通过 `mcp__<serverName>__<name>` 注册给模型的工具。
- 双来源目录：运行中的 Loader 条目（权威配置与真实 fiber 状态）+ 组合后的补丁层（被停用的行、行的来源包），合并后一个已移除的服务器仍然可见、可恢复。
- 移除 = 向 profile 用户层 `cordis.patch.yml` 追加按 id 定位的停用补丁，带起止标记；**不改任何包文件**，逐字节可逆。写入后重读运行树，据实报告「已即时生效」或「重启后生效」。
- 移除前把原始行记录到 `<harness home>/.mcp-mini-manager/removed/<rowId>.json`，即使声明它的 bundle 之后变了也能恢复。
- 只读区「疑似自带 MCP 能力的插件」：列出自己用 MCP 连远端、工具命名自定的插件，并说明为何不提供操作。
- 诊断区：profile 目录、写入目标、home 层补丁、读取的补丁层、以及每层中无法解析的构造。
- 中英双语，跟随 DSH 界面语言；样式只使用 `--dsw-*` / `--ds-*` 主题令牌。
- 停用/恢复**不需要重启**：写入的是 profile 用户层补丁，由 DSH 的 `watchUserPatches` 热应用；页面据实报告「已即时生效」还是「重启后生效」。

### 安全

- 浏览器从不发送路径或 YAML，只发送目录接口自己报出的行 id；宿主端对行 id 做文法校验（拒绝任何路径形状）后才使用文件系统。
- 每个带 `Origin` 的请求都要 `Origin` 与 `Host` 一致才放行（`Host` 是恶意页面唯一无法伪造的头），不一致直接 403；请求体另有大小上限。
- 写入为原子替换（临时文件 + rename），并在途中校验起止标记是否配对。
- 配置只以**投影**形式送到页面：`env` / `headers` 只送键名，`!!js` 表达式只送字段路径（如 `env.GITHUB_TOKEN`），表达式的源码与取值都不出宿主进程。

### 已知边界

- fiber `active` 只代表插件装载成功，不代表远端连上了；连接与重连状态只写日志，本插件不猜。
- 读不到 `loader` 服务时页面明示，而不是显示成「没有 MCP 服务器」。
- `dsh-mcp-client` 本身不桥接 MCP resources / prompts。
- 补丁层解析为 YAML 子集：不支持跨行 flow collection、锚点/别名、多行块标量、merge key；不支持的构造会记入诊断信息。
- 补丁文件末尾若无换行，停用会被拒绝（会让"恢复即逐字节还原"不再成立）。
- 本插件自身是一个 bundle，**新装它需要重启一次 `dsh web`**（bundle 清单在启动时读取）；此后停用/恢复 MCP 行都不需要重启。
- 不带 `Origin` 头的请求（curl、脚本）会被放行——它们不是浏览器发起的跨站请求，调用方本来就有本机文件权限。

### 发布

- GitHub: https://github.com/runcat-tommy/dsh-mcp-mini-manager
- 安装：`dsh plugin --profile web add github:runcat-tommy/dsh-mcp-mini-manager`
