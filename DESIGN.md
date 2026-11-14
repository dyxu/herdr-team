# Herdr Team 实现设计

Herdr Team 使用 TypeScript 实现，通过 Markdown 定义团队，在同一个项目目录启动多个 Agent，由 Leader 使用运行后端提供的命令分派任务、读取结果并组织验证。

## 源码与构建

需要 Node.js 22.13+ 和 npm。`npm ci` 安装锁定依赖，`npm run build` 使用 esbuild 生成：

| 产物 | 用途 |
| --- | --- |
| `bin/herdr-team` | 带 Node shebang 的 CLI bundle，含 YAML 解析器和全部内置模板 |
| `bin/library.mjs` | 验证脚本与自动测试使用的模块 bundle |

CLI 可单独复制，运行时仍需 Node.js；无需另行复制 `node_modules`、`templates` 或 TypeScript 源码。修改模板后需要重新构建，已初始化项目中的 `.team` 不会自动更新。内置模板名称从构建时的模板目录发现并排序。

| 文件 | 职责 |
| --- | --- |
| `src/main.ts` / `src/cli.ts` | 入口、参数解析、后端选择与离线操作 |
| `src/config.ts` | frontmatter 校验、成员身份与路径检查 |
| `src/templates.ts` | 模板发现、选择、校验及原子初始化 |
| `src/process.ts` | argv 子进程、逐行 JSON-RPC、超时和退出回收 |
| `src/core.ts` | herdr-core 启动、初始化、复用与状态查询 |
| `src/legacy.ts` | 旧版 Herdr 窗格与 Agent 生命周期 |
| `src/prompts.ts` | 后端专属的团队与角色提示词 |
| `src/state.ts` | 状态路径、配置摘要、记录保存与目录锁 |
| `src/communication.ts` | 可选的初始化后通信检查 |
| `scripts/build.mjs` | 依赖及模板打包 |
| `test/*.test.mjs` | Node 自动测试与官方 RPC 契约校验 |

`scripts/verify-core.py` 保留为真实 core 的独立验证工具，使用时额外需要 Python 3；应用和默认测试不依赖 Python。`scripts/verify-herdr.mjs` 提供显式启用的真实 Herdr/Agent 集成验证。

## CLI 与后端选择

`--backend auto` 为默认值：环境中 `HERDR_ENV=1` 时使用旧版 Herdr，其他情况使用 herdr-core。可通过 `--backend core` 或 `--backend herdr` 显式指定。

`--init`、`--check`、`--list-templates`、`--status` 两两互斥。前三者是离线操作，不启动 Agent；`--status` 需要连接所选后端，查询已有记录和成员，不创建成员、投递提示、聚焦或关闭终端。

- core 使用当前目录或 `--project` 作为项目，不要求工作区上下文。
- 旧版 Herdr 要求 `HERDR_ENV=1` 及当前 workspace。项目目录依次取显式 `--project`、上下文中的 worktree、workspace 目录、pane 目录；必要时查询当前 pane。
- `--template` 仅用于 `--init`。`--templates-dir` 仅用于 `--init` 或 `--list-templates`，显式参数优先于 `HERDR_TEAM_TEMPLATES_DIR`，显式空字符串可取消环境变量指定的目录。

## 团队定义

```text
.team/
  team.md
  members/
    leader.md
    developer.md
    reviewer.md
```

团队文件包含 YAML frontmatter 和共同指令：

```markdown
---
name: app-team
leader: leader
members:
  - members/leader.md
  - members/developer.md
  - members/reviewer.md
---
所有成员共享项目目录，Leader 分派任务、协调重叠修改并组织最终验证。
```

成员文件使用相同格式，包括 Leader：

```markdown
---
id: developer
kind: codex
args: []
---
根据 Leader 分配的范围实现改动，验证后报告结果和未完成项。
```

团队字段为 `name`、`leader`、`members` 和可选的 `workflow`；成员字段为 `id`、`kind`、`args`。拒绝未知字段、重复 YAML 键、自定义未解析标签及错误类型，不把数字或布尔值转换成字符串。`members`、`args` 必须是字符串数组。

成员 ID 使用 1–20 个小写字母、数字、下划线或连字符，以字母开头，团队中不能重复；Leader 必须是实际成员。成员路径必须是 `.team` 内的 Markdown 文件，解析真实路径后仍需位于该目录。启动参数不能包含 NUL。

`kind` 和 `args` 交给后端启动程序。core 使用 `/usr/bin/env <kind> ...args`，Codex 额外附加 `--no-daemon`；旧版 Herdr 使用其支持的 kind。Agent 需报告 OSC 7501 状态并保持交互运行，实际协作还需具备调用后端 CLI 的权限。

## 模板初始化

默认模板为 `development`，另提供 `minimal`、`product`、`fullstack`、`research`、`content`、`data-analysis`、`security` 和 `router-worker`。

模板结构与 `.team` 相同，可指定内置名称、显式模板目录，或通过 `--templates-dir` / `HERDR_TEAM_TEMPLATES_DIR` 指定命名模板根目录。同名用户模板优先于内置模板；命名模板优先于同名相对目录，使用 `./NAME` 可明确选择本地目录。

外部模板拒绝符号链接和特殊文件，源目录不能等于或包含目标项目。初始化先验证源配置，在项目内暂存并再次校验，独占预留 `.team` 后原子发布。已有 `.team` 拒绝覆盖；失败清理暂存目录。`--list-templates` 列出内置及有效的用户模板。

Router/Worker 的职责、任务记录与共享目录规则见[模板设计](docs/router-worker.md)。

## herdr-core 生命周期

以仓库保存的官方 0.1.21 [OpenRPC schema](testdata/herdr-core/released.openrpc.json) 为协议基准，通过 `herdr-core connect` plain 模式交换逐行 JSON-RPC 2.0，不解析 CLI `run/ls` 的简略输出。

1. 调用 `server.status` 取得永久 core ID。启动记录按 core ID 和项目真实路径隔离，不受调用终端变化影响。
2. 先保存所有计划成员名称，再用 `terminal.run` 创建终端：`wait=false`、`no_parent=true`、`no_notify=true`，附团队标签。
3. 普通成员先初始化，Leader 最后初始化。每个成员先通过 `terminal.wait` 等待 idle/done，再用 `terminal.get` 核验地址、名称、目录、标签和 live 状态。就绪与 settle 重试共用 60 秒预算。
4. 使用 `terminal.send` 投递角色提示，idle 时带 `if=idle`，done 时不发送不合法的 `if=done`，始终 `force=false`。
5. 仅当结构化错误精确匹配启动 settle 拒绝、且 hint 明确为 `nothing was typed` 时，按 100ms 退避并重新验证身份后重试。普通 unavailable、身份变化、blocked、丢失响应、缺少 turn、超时或取消均不盲目重发。
6. send 返回后以相同 caller 跟踪本轮 wait，总预算为 120 秒。`started=false` 不等于失败；message 和 timeout 是中断或检查点，继续等待同一轮。最终须为已结束的 idle/done。
7. 全部角色初始化成功后，按配置执行可选通信检查，再保存 ready 并输出 attach 命令。

caller 使用 `HC_TERMINAL_ID`，未设置时为 `ppid:<启动器进程 ID>`，跨 connect 子进程保持稳定。每次 RPC 有 200 秒上限，并受调用方更短的总预算约束；校验版本、请求 ID、非空 result 和结构化错误，忽略合法通知。关闭 stdin 后等待 connect 退出，异常、超时和持有管道的后代进程不能无限阻塞启动器。

角色初始化本轮只回复 `<成员 ID> ready.` 并结束，不执行工具、读项目、分派任务、发送就绪消息或进入 wait 循环。通信与开发发生在后续回合。blocked 时读取 `status.kind` 并给出 attach 指引，不自动批准弹窗。

只有身份匹配且完整 ready 的团队可复用。名称和团队标签也用于发现启动响应丢失的成员，阻止重复创建。部分失败保存 partial、阶段与错误，保留终端，不自动重启或重放提示。

## 旧版 Herdr 生命周期

插件 ID 为 `herdr-team`，要求 Herdr 0.9.3+。`herdr-plugin.toml` 的构建步骤依次执行 `npm ci --include=dev`、`npm run build`，action 继续调用 `bin/herdr-team`。

1. 从当前 workspace 取得项目，校验配置并从 `agent start --help` 的 `--kind` 选项段发现支持的类型。支持换行、ANSI、CRLF；解析失败报告版本和排查命令。
2. 创建团队 tab 和成员 panes，全部使用当前项目目录。每次保存后端返回的身份，再将 pane 命名为成员 ID。
3. 使用带随机团队前缀的唯一名称启动 Agent，保留配置中的 kind 和 argv。
4. 普通成员最多并行初始化 4 个。身份必须匹配且为可交互的 idle/done；starting、initializing 或暂不可交互的 idle/done 每 250ms 检查，最多 30 秒。working、blocked、未知状态及身份变化立即拒绝。
5. 提示只投递一次并等待返回，失败后收集已派出的其他成员结果，串行保存成功标记；未发送的成员保持未初始化。普通成员全部成功后才初始化 Leader。
6. 按配置执行通信检查，保存 ready 并聚焦 Leader。聚焦失败保留 ready，下次仅重试复用与聚焦。

`agent prompt --wait` 不跟踪唯一回合，get 与 prompt 也非原子操作，因此初始化期间不应从其他调用方发送任务。失败诊断保留结构化错误、stderr 和超时原因，命令标签不附带角色正文或敏感启动参数。

## 日常协作与通信检查

所有成员共享当前 worktree，保留已有改动；重叠写入和 Git 操作由 Leader 协调。启动器不创建分支或 worktree。

| 操作 | herdr-core | 旧版 Herdr |
| --- | --- | --- |
| 查询 | `herdr-core get <terminal>` | `herdr agent get <name>` |
| 分派 | `herdr-core send <terminal> '任务'` | `herdr agent prompt <name> '任务'` |
| 等待 | `herdr-core wait <terminal> --timeout 120` | `herdr agent wait <name> --timeout 120000` |
| 读取 | `herdr-core read <terminal> --lines 120` | `herdr agent read <name> --source recent-unwrapped --lines 120` |
| 成员汇报 | 向 Leader 终端地址 send 报告，随后结束本轮 | 在成员会话中回复，由 Leader read 收集 |

使用启动提示中的实际二进制路径和成员地址；core 名单使用不可复用的终端地址，旧版 Herdr 使用带团队前缀的名称。idle/done 只表示回合结束，须读取实际结果后判断任务状态。超时先检查输出，不直接重复分派。

在团队 frontmatter 设置 `workflow: router-worker` 可启用独立的初始化后通信检查，默认模板未启用。Router 实际查询 Worker，Worker 查询 Router 并向其发送一次性 challenge，Router 收到消息后写回执。启动器验证查询结果的身份及回执，成功后记录 `communication_check: verified`；失败时为 partial / checking communication，保留探针脚本和证据，不自动批准或重发。具体配置与限制见[通信检查说明](docs/router-worker.md#可选通信检查)。

## 状态、并发与迁移

状态目录优先取 `HERDR_PLUGIN_STATE_DIR`，默认沿用 `~/.local/state/herdr-agent-team`。记录保存项目、团队和成员身份、配置 SHA-256 摘要、启动阶段、错误及可选通信检查状态。`--status` 即使当前 `.team` 配置损坏，也可显示已有记录和后端状态。

配置变更只提示，不修改正在运行的团队。旧记录没有摘要时明确提示无法比较。原 Go 版本的记录路径和 JSON 格式保留，摘要也保留字段顺序、缺省 args 的 null 表示和 HTML 转义，已有配置无需转换；已用原 Go 产物创建的模拟团队验证跨版本复用。

启动使用 `<记录文件>.lock.d` 原子目录锁，owner.json 保存 PID 与创建时间。正常结束在 finally 中释放，异常退出可能残留；恢复步骤见[验证指南](docs/verification.md#启动目录锁残留)。旧版 flock 与新目录锁不互通，迁移前需先结束旧版初始化进程。已有存活团队不等于仍有初始化进程，不能通过删除启动记录来代替排查。

本项目负责配置、启动与交接，不提供日常任务数据库、可靠事件队列、后台调度器、动态扩容或自动崩溃恢复。任务索引与文件占用属于 Agent 协作约定，可选通信探针也不是消息队列或沙箱权限隔离。

安装与操作见 [README](README.md)，测试入口、验证范围和历史记录见[验证指南](docs/verification.md)。协议依据保留在[core schema 说明](testdata/herdr-core/README.md)及既有 Herdr CLI 兼容性测试中。
