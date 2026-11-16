# Herdr Team

用 Markdown 定义 Agent 团队，由 Leader 分派任务、协调开发与评审，并验证结果。支持 herdr-core 和旧版 Herdr 插件，所有成员共享同一个项目目录。

## 快速开始：herdr-core

支持 macOS 和 Linux。需要 Node.js 22.13+、npm、herdr-core（已验证 0.1.21），以及已安装并登录的 Agent CLI，默认使用 Codex。

在本仓库目录构建，指定要协作的项目：

```sh
npm ci
npm run build
team="$PWD/bin/herdr-team"
project="/absolute/project/path"

# 首次使用：创建 Leader、Developer、Reviewer 团队
"$team" init "$project"

# 启动团队
"$team" core start "$project"
```

已有 `.team/` 时跳过 `init`。在目标项目目录执行 `start`、`status` 或 `check` 时，可省略项目路径。构建产物 `bin/herdr-team` 已包含依赖和全部内置模板，可单独复制使用；运行机器仍需 Node.js。

等待输出 `Team ready`，执行输出中的 `herdr-core attach <leader-name>` 进入 Leader，然后描述任务，例如：

> 实现登录功能，让 developer 开发、reviewer 评审，你负责协调和最终验证。

角色初始化期间，成员只回复就绪；收到实际任务后才开始工作。再次启动会复用已有完整团队。默认初始化不验证 Agent 是否有权限调用团队通信命令；可为 router-worker 启用[独立通信检查](docs/router-worker.md#可选通信检查)。

## 配置与模板

- `.team/team.md`：团队规则、Leader 和成员名单。
- `.team/members/*.md`：成员职责、Agent 命令 `kind` 和启动参数 `args`。

自定义 Agent 需支持 OSC 7501 状态上报，并保持交互运行。修改配置后，关闭旧团队再启动才能生效。

默认模板为 `development`；`init "$project" minimal` 创建两人团队，`init "$project" router-worker` 选择 Router / Worker 模板。

`router-worker` 创建一个 Router 和两个通用 Worker：Router 保留原始请求并协调任务归属与文件占用，Worker 自主完成调查、实现、验证和后续修复。适合多个独立任务；设计依据和共享目录下的适配见 [Router / Worker 模板设计](docs/router-worker.md)。

```sh
# 使用 Router / Worker 模板初始化新团队
"$team" init "$project" router-worker

# 查看可用模板
"$team" templates

# 检查当前团队配置
"$team" check "$project"
```

## 命令

| 命令 | 用途 |
| --- | --- |
| `init [项目] [模板] [模板根目录]` | 创建 `.team`，默认模板为 development |
| `start [项目]` | 启动或复用团队 |
| `status [json] [项目]` | 查询启动记录和实时成员状态，可输出 JSON |
| `doctor [communication] [项目]` | 基本诊断，或显式验证空闲成员的通信权限 |
| `stop [项目]` | 校验身份后停止记录中的团队，保留历史 |
| `lock <inspect\|recover> [项目]` | 检查启动锁，恢复确认已退出的本机 owner |
| `record list [项目]` | 离线列出项目启动记录 |
| `record show <记录文件>` | 离线查看记录，实时状态未知 |
| `record lock <inspect\|recover> <记录文件>` | 后端不可用时按明确记录路径诊断或恢复锁 |
| `task <操作> ...` | 管理任务卡、范围、反馈、报告和验收，见[任务账本](docs/tasks.md) |
| `check [项目]` | 离线校验团队配置 |
| `templates [模板根目录]` | 离线列出模板 |
| `help [命令]` | 查看帮助；无参数运行也显示帮助 |

例如在当前目录使用 `herdr-team init . router-worker`。命令前可加 `core`、`herdr` 或 `auto` 分组指定后端。命名模板根目录也可通过 `HERDR_TEAM_TEMPLATES_DIR` 设置。

## 状态与故障处理

```sh
"$team" core status "$project"
```

- **启动画面未稳定**：插件会对明确未输入的角色提示自动重试，等待结果即可。
- **权限、登录或问题确认**：按报错中的 attach 命令进入对应终端手动处理。
- **提示可能已送达**：先查看终端画面，不要盲目重发。
- **上次团队启动不完整**：根据状态记录，只关闭该失败团队的终端后重试；不要只删除记录而保留旧终端。
- **启动锁残留**：先运行 `lock inspect`；后端不可用时使用 `record list` 和 `record lock inspect <记录文件>`。只对确认退出的本机 owner 使用 `recover`；缺失 owner 或残留 recovery guard 的处理见[恢复步骤](docs/verification.md#启动目录锁残留)。
- **任务索引写入失败**：`index_warning` 表示任务卡已经提交，不要重放原操作。排除索引路径问题后执行 `task reindex`。

## 旧版 Herdr 插件

需要 Node.js 22.13+、npm、Git 和 Herdr 0.9.3+：

```sh
herdr plugin install dyxu/herdr-team
```

插件安装时会执行 `npm ci --include=dev` 和 `npm run build`。

在 Herdr 中选中目标项目，从 action palette 依次选择 **Initialize project Herdr Team** 和 **Start project Herdr Team**；已有 `.team/` 时跳过初始化。启动完成后向 Leader 描述任务。

省略后端分组时自动选择：旧版 Herdr 环境使用插件后端，其他环境使用 core。可用 `herdr-team core start` 或 `herdr-team herdr start` 显式指定。

## 开发与迁移

在仓库根目录执行：

```sh
npm ci
npm run format:check
npm run check
npm test
```

`npm test` 会先构建，再执行自动测试，不启动真实 Agent。`.team` 配置和启动记录无需转换。CLI 已改为子命令，原双横杠操作参数不再接受，调用脚本需同步更新；升级时先结束旧版初始化进程，再构建和使用新版 CLI。

实现结构与迁移细节见 [DESIGN.md](DESIGN.md)，真实后端验证、历史记录与故障处理见[验证指南](docs/verification.md)。
