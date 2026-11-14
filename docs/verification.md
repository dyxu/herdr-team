# 验证与故障排查

以下命令均在仓库根目录执行。应用、构建和默认测试需要 Node.js 22.13+ 与 npm；真实 core 回归额外需要 Python 3 和已安装的 herdr-core。真实 Agent 测试还需要对应 CLI 已安装并登录。

## 自动检查

```sh
npm ci
npm run format:check
npm run check
npm test
```

`npm test` 先构建 `bin/herdr-team` 和 `bin/library.mjs`，再运行 `test/*.test.mjs`。全部内置模板和 YAML 依赖打包在产物中，测试会把 CLI 复制到临时目录，验证其不依赖仓库位置或 `node_modules`。

| 测试文件 | 覆盖范围 |
| --- | --- |
| `test/config.test.mjs` | 模板发现、优先级、拒绝覆盖、外部模板检查、严格 YAML、成员边界、CLI 参数、摘要和目录锁 |
| `test/core.test.mjs` | JSON-RPC 子进程、官方参数契约、初始化与复用、稳定 caller、settle 重试、消息打断、超时、权限和不确定投递 |
| `test/legacy.test.mjs` | 旧版 Herdr 的项目上下文、kind 发现、并发初始化、部分失败保存、状态查询及聚焦重试 |
| `test/communication.test.mjs` | 可选通信检查的正确、缺失、过期回执，错误身份、符号链接和失败状态 |

默认测试使用模拟后端和执行者，不启动真实 Agent，不需要厂商凭据。GitHub Actions 配置了 macOS / Linux 与 Node 22 / 24 的组合，并检查构建后的模板列表、初始化和 `--check`；配置 CI 矩阵不代表本机已经执行了 Linux 验证。

## 真实 herdr-core 回归

此测试运行真实 core 和报告 OSC 7501 状态的 Python fixture，不启动 Codex 等 Agent，也不需要厂商凭据：

```sh
npm ci
npm run verify:core

# 指定 core 路径时使用：
npm run verify:core -- --core /absolute/path/to/herdr-core
```

也可在已有构建产物时直接运行：

```sh
python3 scripts/verify-core.py --core /absolute/path/to/herdr-core
```

脚本使用专用 socket、`HC_SESSION`、XDG 目录和临时项目，与用户已有 core 分开。验证以下场景后，清理本次 core 及终端：

- idle / done 状态下初始化，查询状态并重复启动；每个角色仅实际接收一次提示。
- 初始化后向 caller 发消息，验证 wait 被 message 打断后继续同一轮，不重发。
- 先报告 idle，再持续输出 6.5 秒，复现 core 的 settle 拒绝，验证仅对 `nothing was typed` 安全重试。
- 提示送达后报告 blocked:permission，验证启动记录为 partial，错误含 attach 指引，状态查询不自动回答弹窗。

## 真实 Agent 验证

### herdr-core 手动测试

下面会启动两个真实 Agent，可能消耗额度。先构建，再在独立临时项目和状态目录中运行：

```sh
npm run build
plugin="$PWD/bin/herdr-team"
test_project="$(mktemp -d)"
test_state="$(mktemp -d)"

"$plugin" --init --template minimal --project "$test_project"
HERDR_PLUGIN_STATE_DIR="$test_state" "$plugin" --backend core --project "$test_project"
HERDR_PLUGIN_STATE_DIR="$test_state" "$plugin" --backend core --status --project "$test_project"
HERDR_PLUGIN_STATE_DIR="$test_state" "$plugin" --backend core --project "$test_project"
```

这些命令使用当前 core，独立的 `HERDR_PLUGIN_STATE_DIR` 只隔离插件记录。需要进一步隔离 core 时，应同时使用专用 socket、session 和 XDG 目录；现有 `verify-core.py` 展示了该配置方式，但它自身运行的是 fixture。

检查重复启动未新增终端、未重发角色提示，再按输出的 attach 命令进入 Leader 并分派一个可验证的小任务。router-worker 可将初始化命令改为 `--template router-worker`，分派两个需要修改同一文件的任务，检查范围申报、串行写入、实际报告及最终验证。

默认的角色 ready 仅证明初始化回合结束，不能证明团队通信权限可用。可按[模板说明](router-worker.md#可选通信检查)启用 `workflow: router-worker`，让启动器在角色初始化后独立验证查询和回执。此检查使用真实 Agent 执行工具，可能触发权限或登录确认；不会自动批准、修改沙箱或重复发送。

测试结束后只关闭启动记录中属于本次测试的终端，再清理临时项目和状态目录。不要停止用户已有 core，也不要只删除记录而留下运行成员。

### 旧版 Herdr 自动集成测试

在已登录 Agent 的 Herdr 窗格中显式启用：

```sh
HERDR_TEAM_INTEGRATION=1 npm run verify:herdr
```

脚本要求 `HERDR_ENV=1`，创建独立临时项目和状态目录，启动 minimal 团队的两个真实 Agent，检查初始化、状态、重复复用和配置变更。结束时尝试关闭本次测试 tab 并恢复调用方 tab，清理失败时保留路径供检查。不会批准登录、信任或权限弹窗。

未设置 `HERDR_TEAM_INTEGRATION=1` 时打印 skipped，默认 `npm test` 和 CI 也不会调用此真实测试入口。它验证启动生命周期，不代表已完成真实开发任务或 router-worker 的端到端协作。

## 故障排查

先运行对应后端的 `--status --project ...`，读取启动阶段、错误、成员身份及实际终端状态，再决定下一步。

| 现象 | 处理方式 |
| --- | --- |
| 角色初始化成功，但首次分派失败 | 检查 Agent 自身是否能访问 core socket / Herdr CLI；ready 不等于通信权限已验证 |
| blocked / 登录 / 权限 / 问题确认 | core 使用报错中的 attach 命令，旧版 Herdr 打开对应 pane，由用户处理 |
| send 失败、超时或响应丢失 | 先 get/read 核实是否已送达，不直接重发 |
| partial 且启动器已退出 | 检查保留的成员和错误；排查后关闭该团队，再启动，不自动续接未完成初始化 |
| 配置变更 | 运行中的团队仍使用旧配置，关闭旧团队后启动才生效 |
| 配置文件损坏 | 仍可用 `--status` 查询已有团队，再修复 `.team` |
| 通信检查未通过 | 查看 `checking communication` 阶段和 `.team/.communication-*` 中保留的脚本与证据；待权限问题解决后按 partial 流程处理 |
| Herdr kind 不支持或解析失败 | 查看 `herdr --version`、`herdr status server`、`herdr agent start --help`，核对 kind 和客户端兼容性 |

启动器会保留错误现场；测试脚本各自的自动清理行为以对应章节为准。不要通过 `--force` 越过 blocked 对话框，也不要重启不属于本次测试的团队。

### 启动目录锁残留

TypeScript 版本使用 `<启动记录文件>.lock.d` 目录锁，正常结束自动释放。进程异常终止后可能留下锁，报错会给出锁目录；其中 `owner.json` 保存 PID 和创建时间。

1. 用错误路径定位锁目录，读取 `owner.json`，核对该 PID 及项目相关初始化进程是否仍在运行。
2. 如果仍有初始化进程，等待其完成或先处理其阻塞，不删除锁。
3. 只有确认对应初始化进程已退出后，才手动删除这个锁目录。保留启动记录与团队终端，先 `--status` 诊断是否为 ready 或 partial，再决定是否重试。

旧版 Go 使用 flock，与新目录锁不互通。升级到 TypeScript 版本前，先结束旧版初始化进程；已有完整 ready 团队的记录和配置无需转换。

## 验证记录

### TypeScript 迁移（2026-11-14）

- 在 Node 22.23.5 上执行全部 61 项自动测试，通过；本机 Node 26.4.0 完成自动测试与配置校验回归，类型、格式和构建检查通过。
- 用迁移前 Go CLI 创建模拟 core 团队，再用 TypeScript 版启动：复用同一记录和成员，配置摘要一致，没有重复创建或投递。摘要基准保存在自动测试中。
- TypeScript CLI 对本机真实 herdr-core 0.1.21 执行 fixture 回归，idle、done、message、settling、permission 场景全部通过，独立 core 和终端已清理。
- 本轮没有重新启动真实厂商 Agent，也未在本机执行 Linux 或 Node 24 验证；可选通信检查的真实 Agent 端到端结果仍待补充。

### 历史记录：Go 版本

以下记录发生在 TypeScript 迁移前，用于保留当时的验证范围，不作为新版的端到端验证结论。

| 日期 | 环境与结果 | 范围 |
| --- | --- | --- |
| 2026-11-03 | macOS、Herdr 客户端及服务端 0.9.5、Codex；真实集成测试通过，测试 tab 已清理 | 初始化、状态、重复复用、配置变更；权限等异常由模拟覆盖 |
| 2026-11-13 | macOS、herdr-core 0.1.21；独立 fixture 回归通过并清理 | 初始化、settle 重试、消息打断、复用及权限阻塞；无真实 Agent |
| 2026-11-13 | herdr-core 0.1.21、Codex 0.169.0；本仓库 Leader、Developer、Reviewer 就绪，turn=2 与终端身份在复用后不变 | 仅启动与复用，未分派开发任务；测试团队单独清理，原失败团队未改动 |
| 2026-11-14 | herdr-core 0.1.21、Codex 0.169.0；router-worker 三成员初始化及复用通过，Router 首次 get Worker 被自身沙箱拦截，进入权限确认 | 两个 Worker 尚未收到同文件开发任务；未批准弹窗，协作未验证通过 |

最后一次真实 router-worker 测试当时将现场与画面保存到 `/private/tmp/herdr-rw-live-d_9h4xjz/`。这是临时路径，可能已被清理，不属于项目长期归档，也不保证对应终端仍在运行。
