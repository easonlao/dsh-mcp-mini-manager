# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.5.4] - 2026-10-16

### 修复

- **补上宿主版本要求（peer 声明）**：本包此前没有 `peerDependencies`，社区市场只能把它判为 `unknown`。市场只认三类声明——`engines.dsh`，以及 `peerDependencies` 里既在**宿主包清单**内、又匹配 `@deepseek-ai/dsh*` 的项（`dshmarket/lib/discovery-compatibility.js` 的 `deriveHostCompatibility`）；一条都没有，插件就无法对外声明「我支持 0.2.x」。
  - 现补 3 条，正是 `dsh.client.inject` 已声明的三个包：`@deepseek-ai/dsh-client-runtime` / `dsh-client-locale` / `dsh-client-ui-settings`，范围统一为 **`^0.1.0-rc.6 || ^0.2.0-rc.1`**。
  - 为什么是两段式：只写 `^0.2.0-rc.1` 会把仍在 0.1.x 宿主上的用户判成 `incompatible`；两段式同时覆盖 `0.1.0-rc.6` / `0.1.0-rc.8` / `0.1.1-rc.2` / `0.2.0-rc.2` / `0.2.1-alpha.4`。**日后两条线若不可兼得，以 0.2.x 为准，放弃 0.1.x。**
- **修正 `test/client.test.mjs` 里一条假设了旧目录布局的断言**：那条「每个 CSS 自定义属性都是宿主主题 token」的用例去读 `dsh-client-ui-theme/lib/styles/*.css`，而 0.2.x 把 token 定义搬进了 `lib/client.js`（`lib/styles/` 只剩 `brand-font.css`），于是它读到 0 个 token 便断言失败——**红的是测试的路径假设，不是 token 真的没了**。现同时扫 `lib/{client,index}.js` 与 `lib/styles/*.css`，在本机 0.2.0-rc.2 上重新成立（该用例真实核对 20 个宿主 token，全部有定义）。

### 说明

- `lib/` 只有 `VERSION` 常量跟着版本号走（`1.5.3` → `1.5.4`），运行逻辑与 1.5.3 相同。
- 实测证据（宿主 `0.2.0-rc.2`，验收工具为仓库外的 `verify-compat.mjs`，判定直接复用 dshmarket 自己的函数）：改前 `unknown` → 改后 `compatible`；`profiles/web` 体检本插件无 peer 警告；单测 113 项全绿。

### 发布

- npm：`dsh-mcp-mini-manager@1.5.4`
- GitHub：https://github.com/runcat-tommy/dsh-mcp-mini-manager

## [1.5.3] - 2026-10-13

### 文档

- 安装章节把「下载安装」写成完整一条路：先在 GitHub 上 **Code → Download ZIP** 解压到固定目录，再 `dsh plugin --profile web add <目录>`；`git clone` 变成等价备选。并提醒别解压到临时目录——路径会写进 profile 依赖。
- 修正 npm 那条里已经过时的话。原文写「npm 版本可能落后于 GitHub main」，但 1.5.1 发布后两边是同一个版本，那句话会让用户白白绕开 npm。现在改为：npm 上是打过标签的稳定版本，想跟 `main` 最新提交才走 ① 或 ②，并补上包地址。
- 三路对照表同步（② 由「本地 clone」改为「下载再装」），并点明三条路装的是同一个包。
- 中英文两版逐节对齐（16 个标题、各 8 个代码块）。

### 说明

- 版本号跳过 1.5.2。该版本号在本次文档修订发布之前，已被一次发布机制探针占用（探针内容与 1.5.1 相同，挂在 `probe` 标签下，仅用于判定发布是否真的落到 registry）。npm 不允许覆盖已发布的版本号，而删除它需要账号 2FA，故本次改用 1.5.3。`latest` 始终指向正式版本，`npm install` 不受影响。

### 工具（仅仓库，不在 npm 包内）

- 新增 `test/market-gates.test.mjs`：把市场收录的**静态门槛**钉成测试。这些门槛会**静默失效**——代码与单测全绿，市场却不再收录或降级为"引导安装"。共 29 条断言，覆盖 manifest 形状、`dsh.bundle.patch` 的安全性、patch 里 `insert` 的 `name` 是否等于 npm 包名、`.gitignore` 是否吞掉 `lib/`、`dsh.marketplace` 四件套、README 是否给出 `add github:owner/repo` 且 owner/repo 与仓库一致、`screenshots.json` 的路径与格式。每条断言都写明"不满足要付出什么代价"，失败时给的是后果而不是断言文本。
  - 默认离线运行，随 `npm test` 执行；需要联网的两组（`dsh-plugin` topic、npm 与仓库版本一致）用 `MMM_ONLINE=1` 开启。
  - 断言本身做了变异验证：改坏 insert 名、让 `.gitignore` 吞掉 `lib/`、翻转 `requiresRestart`、指向不存在的截图、放入 `.svg`、放入过小图片——6 种改坏方式都被正确捕获，确认不是"永远通过"的空断言。
- 新增 `scripts/registry-inclusion.mjs`：查中心 registry 快照（约 17 MB）里本仓库是否已被自动收录，并打印条目的 `verifiedCommit` / `verifiedAt` / `requiresRestart` 等字段。镜像依次尝试 jsDelivr、raw.githubusercontent.com，最后回退到 `curl`（该文件用 Node 的 fetch 拉取会间歇性 ECONNRESET，jsDelivr 有时直接 403）。**未收录不等于失败**，也不该据此提 issue：扫描按天刷新，0 星条目还会被"按 star 降序截断前 1000"挤掉。
  - 注意：`scripts/` 不在 `files` 里，所以没有把它写进 `package.json` 的 `scripts` 字段——否则 npm 上的包会引用一个不存在的文件。想直接跑这个脚本请用仓库副本，或在下个版本把 `scripts` 一并纳入发布。

### 发布

- GitHub: https://github.com/runcat-tommy/dsh-mcp-mini-manager
- npm: https://www.npmjs.com/package/dsh-mcp-mini-manager
- 安装：`dsh plugin --profile web add dsh-mcp-mini-manager`
- 市场登记：`awesome-dsh-plugin/awesome-dsh-plugin` PR [#7422](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7422)（单 yml）、`0xsline/awesome-deepseek-harness` PR [#709](https://github.com/0xsline/awesome-deepseek-harness/pull/709)（README 中英各一行）

## [1.5.1] - 2026-10-13

首个发布版本。版本号从 1.5.1 起（首个公开发布，非 1.0.0）。

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
- `screenshots.json` 与 `assets/` 下的中英界面预览图（市场详情页的预览图来自它，而不是从 README 抽图）。
- npm 上发布英文 README（`"readme": "README.en.md"`），与已发布的同类插件一致；npm 默认会发中文的 `README.md`。

### 修复

- **同一个 MCP 不再显示成两行。** 行的身份原先取 `entry.id`，但那是 Loader 的**合成路径**而不是行自己的 id：根 Include 按设计会给子项加命名空间前缀，于是用 `- insert: [{id: mcp-grafana}]` 声明的行被报成 `include:mcp-grafana`，与补丁层声明的 `mcp-grafana` 无法归并——页面出现两行（一行在用、一行「未观测」），而且停用按钮指向一个任何补丁都定位不到的 id。现在按行**声明时使用的 id**（`options.id`）作为身份，它才是补丁能定位的那一个。
- **行的来源按「层」判定，不再按补丁的形状猜。** 原先"是不是 `insert`"被当成了"是不是包提供的"，于是用户在**自己的** `cordis.patch.yml` 里手写的 `- insert:` 行被标成来自插件包。现在读每一层时给补丁打上该层标记，来源是事实而非推断；`inUserPatch` 也随之回到它字面的意思——「这行由你能编辑的文件描述」。
- **一次 config 覆盖不再改变行的来源。** 包引入的行被用户调参之后仍然是包引入的行；覆盖补丁自身的形状不含层信息，据它改写来源只是把猜测伪装成事实。
- **测试不再读开发者的真实 `~/.dsh`。** 原先只有走假 Loader 的用例靠 `baseUrl` 隔离，直接调用 `apply(ctx)` 的用例会解析到真实 harness home——测试结果取决于本机恰好装了什么，写入还可能落到真实 profile。`sandbox()` 现在把 `DSH_HOME` 指向沙箱，并在结束时还原。

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
- npm: https://www.npmjs.com/package/dsh-mcp-mini-manager
- 安装：`dsh plugin --profile web add github:runcat-tommy/dsh-mcp-mini-manager` 或 `dsh plugin --profile web add dsh-mcp-mini-manager`
