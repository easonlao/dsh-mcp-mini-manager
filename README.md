# dsh-mcp-mini-manager

[English](README.en.md) | 中文

DSH 的 **MCP 极简管理**：在「设置」里加一页，与「插件」同级，列出当前 DSH 实际装载的每个 MCP 服务器及其简介与状态，并且可以逐个移除。

- **插件 id**：`dsh-mcp-mini-manager`
- **中文名**：MCP 极简管理
- **英文名**：MCP Mini Manager
- **设置页 id**：`mcp-mini-manager`（`settings.section`，order 16，紧接「插件」）

## 它解决什么

DSH 里没有一处能看到「我现在装了哪些 MCP」。要知道这件事，只能去翻 `cordis.patch.yml`、再看各个包的 bundle 补丁，还要自己判断哪一行是 MCP；移除一个 MCP 更没有任何界面入口。这一页把这两件事做成一步。

## 它为什么能知道有哪些 MCP

这是本插件唯一需要解释的设计点。

在 DSH 里，**一个 MCP 服务器就是 cordis 装载树里的一行**，模块是 `@deepseek-ai/dsh-mcp-client`。这一点写在该包自己的类型文档里：

> MCP client bridge plugin: connects to an external MCP server and registers its tools on `ctx.tools` … **Each plugin instance connects to one MCP server; load multiple instances in `cordis.yml` for multiple servers.**

所以「装了哪些 MCP」= 「`ctx.loader` 的条目里哪些是 `dsh-mcp-client`」。本插件从**两处**读，并合并：

| 来源 | 提供什么 | 局限 |
|---|---|---|
| **运行中的 Loader**（`ctx.loader.entries()`） | 权威的 `config`（`serverName` / `transport` / `command` / `url` …）与真实 fiber 状态 | **看不见被停用的行**——停用的行根本不在树里 |
| **补丁层**（各 bundle 的 `cordis.patch.yml` + profile 的 `cordis.patch.yml` + `~/.dsh/cordis.patch.yml`） | 被停用的行、以及从哪个包来的 | 只有静态配置，没有运行状态 |

两边合并后，一个「昨天被移除」的 MCP 仍然会出现在页面上，带着「已移除」状态和它的原始配置（来自移除记录）。合并规则：**运行中的树在它能看见的事情上优先**，补丁层补上树结构上看不见的那部分。

页面严格遵守一条边界：**浏览器从不发送路径，也不发送 YAML**。每个请求只带一个**行 id**，而这个 id 是本插件的目录接口自己报出去的；host 端会重新确认「它现在确实是一个 MCP 客户端行」之后，才推导要写哪个文件、写哪一段。

## 移除是怎么实现的

「移除」= 往 **profile 自己的** `cordis.patch.yml` 追加一段按 id 定位的停用补丁：

```yaml
# >>> dsh-mcp-mini-manager: disabled mcp row mcp-github
# server: github
# removed: <ISO 时间戳> by dsh-mcp-mini-manager
# restore this server from the MCP 极简管理 settings page, or delete
# these lines to re-enable the row by hand.
- id: mcp-github
  disabled: true
# <<< dsh-mcp-mini-manager: disabled mcp row mcp-github
```

这条路径有三个刻意的性质：

1. **不改任何包文件。** 目标行可能来自 `dsh-base`、`dsh-web-app` 或第三方插件的补丁层，那些目录是包自己的、重装即还原。停用写进的是**用户层**，也就是 `dsh-app-boot` 每次启动都会应用、并且**用户在编辑**的那一层。
2. **不需要重启。** DSH 启动时会 `watchUserPatches` 监听 profile 层与 home 层，写入后会被重新解析并应用。host 端在写完后会**重新读一次运行树**，据实告诉你是「已即时生效」还是「重启后生效」，而不是替你承诺。
3. **可恢复。** 写补丁**之前**，原始那一行会先存到 `<harness home>/.mcp-mini-manager/removed/<rowId>.json`。页面上的「恢复」只做一件事：删掉那段停用块。停用再恢复是**逐字节还原**——文件里你原本的注释、`!!js` 表达式、其他插件的补丁都原样不动，因为写入是**行级拼接**，不是 YAML 解析后重写。

> **为什么不整份重新序列化 YAML。** 那个文件是用户手写的、被所有插件共用。任何「解析 → 修改 → 重新导出」都会把注释和 `!!js` 表达式重排甚至改义，从而悄悄弄坏别的插件。所以本插件只做行级插入与整段删除，且每段都有自己的起止标记。

### 会被拒绝的情况（都是刻意的）

| 情况 | 行为 |
|---|---|
| 这一行已经是停用状态 | 拒绝（`already-disabled`），文件不动 |
| 起止标记不配对（手改过、或写入被打断） | 拒绝（`marker-unpaired`）——此时这段的边界不可知，拼接或删除都不能诚实完成 |
| 补丁文件末尾没有换行 | 拒绝（`no-trailing-newline`）——会让恢复不再精确 |
| 行 id 的形状像路径（`a/b`、`../x`、`C:\x`） | 在碰文件系统之前就按文法拒绝（`bad-row-id`） |
| 请求来自其他来源（`Origin` 与 `Host` 不一致） | 403 拒绝 |

**用户层里已经有同一行的补丁时，照常写入。** 这一点值得说明，因为直觉上会以为"同 id 重复"要拒绝：`applyEntryPatches` 对每个补丁**独立、按键**应用，所以一条只带 `id` + `disabled` 的补丁和一条带 `name` + `config` 的补丁可以安全共存——DSH 自己就是这样分层的。连"用 `insert` 声明这个 MCP 行"这种最常见的形态也因此照样能移除，否则页面上大部分行都会变成不可操作。

「清空移除记录」是本插件唯一不可逆的操作，它**只删记录文件，不恢复也不删除任何 MCP**，并且需要二次确认。

## 页面上还有什么

- **简介**：每个服务器一行——stdio 显示命令行，streamable-http 显示 endpoint；配置里若含 `!!js` 表达式会标出是哪几个字段（**只报字段名，永不显示值**）。
- **状态**：`在用` / `已移除` / `启动失败` / `启动中` / `未观测`，由 Loader 的 fiber 状态与补丁层共同推导，只出一个结论。
- **工具**：该服务器通过 `mcp__<serverName>__<rawName>` 注册给模型的工具及描述。
- **疑似自带 MCP 能力的插件（只读）**：有些插件自己用 MCP 连远端、工具命名自己决定（不经过 `dsh-mcp-client`）。移除它们等于卸载插件，语义不同，所以这里**只列出、不提供操作**。
- **诊断信息**：profile 目录、写入目标、home 层补丁、读取了哪些补丁层、以及每一层里无法解析的内容。

### 一条要说明的局限

fiber 处于 `active` **只说明插件装载成功，不代表远端连上了**。连接与重连状态只写进日志（`dsh-mcp-client` 用 logger 汇报 reconnecting / recovered / 最终失败），本插件不去猜。页面底部对此有明示。

## 安装

本插件是一个标准的 DSH bundle（声明了 `dsh.bundle.patch` 与 `dsh.client`），把包装进 profile 并**重启一次** `dsh web` 即可。三条路都可用，区别只在"要不要本机有 git / 会不会触发构建审批 / 以后怎么更新"。

### ① 从 GitHub 直接装

```bash
dsh plugin --profile web add github:runcat-tommy/dsh-mcp-mini-manager
```

- **适合**：只是想用，不想 clone。
- **要注意**：需要本机有 `git`。仓库里**已经提交了全部运行产物**（`lib/` 三个文件）且没有任何 `preinstall`/`install`/`postinstall`/`prepare` 脚本，所以通常不会触发构建审批；若 DSH 仍然要求批准，按提示同意即可。
- **更新**：重跑同一条命令。

### ② 下载到本地再装

```bash
git clone https://github.com/runcat-tommy/dsh-mcp-mini-manager.git
dsh plugin --profile web add D:\path\to\dsh-mcp-mini-manager
```

（也可以直接下载 ZIP 解压，然后指向解压出来的目录。）

- **适合**：想改代码、想锁版本、或本机没有网络访问 npm 的场景。
- **要注意**：无需构建审批。`dsh plugin` 实际是 `pnpm` 的转发壳——它在 profile 目录里跑 `pnpm add`，然后按**装载后的真实状态**对齐 `dsh.profile.bundles`。所以也可以用 `pnpm add link:<路径>` 手工挂载，此时要自己把包名加进 `dsh.profile.bundles`（`pnpm add` 不会自动加）：

  ```json
  {
    "dsh": {
      "profile": {
        "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-mcp-mini-manager"]
      }
    }
  }
  ```

- **更新**：`git pull` → 重跑一次 `dsh plugin --profile web add D:\path\to\dsh-mcp-mini-manager` → 重启。

### ③ 从 npm 装

```bash
dsh plugin --profile web add dsh-mcp-mini-manager
```

- **适合**：最省事，包内已带完整产物，安装时不执行 `prepare`。
- **要注意**：npm 上的版本可能落后于 GitHub `main`；想尝新就走 ① 或 ②。
- **更新**：`dsh plugin --profile web up dsh-mcp-mini-manager`。

### 三路对照

| | 命令 | 需要什么 | 构建审批 | 更新方式 |
|---|---|---|---|---|
| ① GitHub 直装 | `… add github:runcat-tommy/dsh-mcp-mini-manager` | 本机有 `git` | 通常不需要（产物已提交、无 install 类脚本） | 重跑同一命令 |
| ② 下载到本地 | `git clone …` 后 `… add D:\path\to\repo` | 无 | 不需要 | `git pull` + 重跑 `add` + 重启 |
| ③ npm | `… add dsh-mcp-mini-manager` | 无 | 不需要 | `… up dsh-mcp-mini-manager` |

**三条路都必须重启一次 `dsh web`**——新 bundle 是在启动时由 profile manifest 读取的，只刷新页面不够（页面会明确提示「插件的主机半侧没有响应」）。装好之后，**停用/恢复 MCP 本身都不需要重启**：写入的是 profile 自己的补丁层，DSH 会热加载它。

查看与卸载：

```bash
dsh plugin --profile web list                        # 看已装了什么
dsh plugin --profile web remove dsh-mcp-mini-manager # 卸载插件（与"停用某个 MCP"是两回事）
```

## 装箱内容

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半：五条 HTTP 路由、读取 Loader 与各补丁层、停用/恢复的写入与守卫 |
| `lib/catalog.js` | 纯函数核心：行分类、配置投影、补丁层解析、`planDisable` / `planRestore` |
| `lib/client.js` | 浏览器半：手写的 `__ModuleLoader__` bundle，注册 `settings.section` |
| `cordis.patch.yml` | bundle 补丁：在本 profile 的装载树里插入一行 |
| `test/` | 81 个测试：纯规则、宿主集成（真实临时目录 + 分层补丁）、浏览器半结构 |
| `scripts/verify-e2e.mjs` | 端到端冒烟：一个进程里加载两侧真入口，跑完整周期（`npm run smoke`） |

浏览器半**不需要构建步骤**：它只 `require("react")` 这一颗平台种子，其余全部用同源 `fetch` 与宿主半对话。文案通过 `locale` 服务注册中英双语，跟随 DSH 界面语言。

## 宿主接口

这些路由挂在 DSH 的 `webServer` 上，**不在 `/api` 网关的同源防护之内**——`Host` 是恶意页面唯一无法伪造的头，所以每个**带 `Origin` 的请求**都要 `Origin` 与 `Host` 一致才放行，不一致直接 403。刻意不带 `Origin` 的请求（curl、脚本）会放行，因为它们不是浏览器发起的跨站请求，这类调用方本来就有本机文件权限。

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/dsh-mcp-mini-manager/api/catalog` | 目录：全部 MCP 行 + 移除记录 + 诊断信息 |
| `GET` | `/dsh-mcp-mini-manager/api/rows` | 原始行（调试用） |
| `POST` | `/dsh-mcp-mini-manager/api/disable` | 停用一个 MCP（body：`{rowId}`） |
| `POST` | `/dsh-mcp-mini-manager/api/restore` | 恢复一个 MCP（body：`{rowId}`） |
| `POST` | `/dsh-mcp-mini-manager/api/purge` | 清空移除记录（**唯一不可逆**，只删记录，不恢复也不删除任何 MCP） |

## 开发

```bash
npm test          # 81 个测试：catalog 纯逻辑 + 宿主集成 + 浏览器半结构
npm run smoke     # 端到端冒烟：在一个进程里加载两侧真入口，跑完整目录/停用/恢复/清空
```

- `lib/catalog.js` — 纯函数：行分类、配置投影、补丁层解析、停用/恢复计划。
- `lib/index.js` — 宿主半：挂 `webServer` 路由，读 Loader 与各补丁层。
- `lib/client.js` — 浏览器半：手写 ModuleLoader bundle，只依赖平台提供的 `react`。

`npm test` 里有两条值得单独说：

- **客户端测试会把样式表里出现的每一个 CSS 自定义属性，逐个对着已安装的 DSH 主题文件校验**。令牌名写错不会报错、只会静默变成无样式，所以这条断言是必要的。
- **`scripts/verify-e2e.mjs` 里的假 Loader 按 `applyEntryPatches` 的真实语义合成补丁层**（逐补丁、逐键覆盖），所以"停用 → 恢复"的往返是在真实的合成语义上验证的，而不是在猜测的语义上。

跑冒烟脚本时请确保 `$DSH_HOME` 指向沙箱：移除记录写在 harness home 下，脚本默认会把它指到临时目录。

## 已知边界

- **必须有 `loader` 服务**才能列出运行中的行；读不到时页面会明说，而不是显示成「没有 MCP」。
- **只桥接工具**：`dsh-mcp-client` 本身不桥接 resources / prompts，所以这里也看不到。
- **补丁层解析是子集**：支持块映射/序列、引号标量、`!!js`、注释、以及 profile 模板里的空列表哨兵 `[]`；不支持跨行 flow collection、锚点/别名、多行块标量、merge key——遇到不支持的构造会记进诊断信息，而不是猜。
- **多 profile**：写入目标永远是当前运行 profile 的用户层（由 Loader 的 `baseUrl` 推导）。

## 许可

MIT
