# Herdr Agent Team 简化方案

只实现两个功能：在当前 Herdr 项目中按团队定义启动多个 Agent；用户在 Leader pane 中下达指令，由 Leader 通过 Herdr 协调成员完成开发任务。

## 团队定义

```text
.team/
  TEAM.md
  members/
    leader.md
    developer.md
    reviewer.md
```

TEAM.md 使用 YAML frontmatter 描述成员，正文描述共同规则：

```markdown
---
name: app-team
leader: leader
members:
  - members/leader.md
  - members/developer.md
  - members/reviewer.md
---
# 团队规则
所有成员在当前项目的同一个 worktree 中工作。
由 Leader 分配任务、协调依赖、检查结果并组织最终验证。
Leader 避免安排成员同时修改同一批文件；有重叠的任务按顺序执行。
成员完成任务后报告修改、验证结果和未解决问题。
```

每个成员使用同一种格式，包括 Leader：

```markdown
---
id: developer
kind: codex
args: []
---
# 开发成员
根据 Leader 的指令修改代码并验证结果。
在共享 worktree 中工作，只修改本次任务涉及的文件，完成后说明结果。
不确定任务范围时，说明问题，等待 Leader 给出下一步指令。
```

kind 和 args 是交给 Herdr 的启动配置。示例中的 codex 可以替换为其他 Herdr 支持的 Agent；插件不包含厂商专用逻辑。Agent 需要能执行 shell 命令，以使用 Herdr 协作。

## 初始化

插件只提供一个 `start-team` action。

1. 从 Herdr 当前项目上下文取得项目目录，读取 `.team/TEAM.md`。
2. 检查成员定义、Leader 引用和本机 Herdr 支持的 kind；启动程序可用性由 Herdr 启动接口检查。
3. 在当前项目的团队 tab 中创建成员 panes，全部使用当前项目目录，通过 `herdr agent start` 启动成员。
4. 检查普通成员的身份、idle/done 状态与交互就绪情况，最多并行向 4 个成员发送团队规则、成员角色、成员名单、实际 Herdr 名称和共享工作区路径。由协调流程逐成员保存结果；失败时收集已派出的其他成员结果。
5. 全部普通成员成功后，同样检查 Leader 并发送包含额外协调说明的初始化提示。保存团队就绪状态，最后聚焦 Leader pane；聚焦失败保留就绪状态，允许下次启动重试聚焦。初始化程序退出。

Herdr 名称带短团队实例前缀，避免不同项目同名；pane 名称设置为对应 Agent 的完整名称，pane ID 使用 Herdr 创建接口返回值。初始化提示同时包含 Herdr 的协作命令说明。

Herdr 的 `prompt --wait` 不跟踪具体回合；提交前状态检查可以拒绝正在工作的成员，但不能消除检查与提交之间的外部输入竞态。初始化期间不应向成员另发指令。CLI 失败诊断保留结构化错误、stderr 和超时原因，命令上下文只包含命令和目标，不附加角色提示正文或启动参数。

初始化无需输入开发目标，团队就绪后直接在 Leader pane 中输入目标。插件不创建 worktree 或分支，所有成员使用当前项目已有的 worktree，包括其中已有的工作内容。

## 日常使用

用户向 Leader 发送自然语言指令，例如：

> 实现登录功能，让 developer 开发、reviewer 评审，你负责协调和最终验证。

Leader 自主执行以下流程：

1. 根据成员角色拆解任务，向对应成员发送目标、约束和验收要求。
2. 修改文件互不重叠的任务先分别发送，再等待成员，形成并行执行；重叠任务按顺序安排。
3. 使用 Herdr 查询状态、等待成员结束，并读取成员回复。
4. 成员完成一个回合后给出结果或问题；Leader 检查实际回复，再决定评审、回答问题或继续分派。
5. Leader 在共享 worktree 检查整体改动，运行最终验证并回复用户。提交代码等 Git 操作由 Leader 统一协调。

通信直接使用现有 Herdr 命令：

```sh
herdr agent prompt <成员名称> "任务说明"
herdr agent wait <成员名称> --until idle --until done --until blocked --timeout 120000
herdr agent read <成员名称> --lines 120
```

这些规则写入 Leader 的初始化提示：等待状态只表示一个回合结束，必须读取结果再判断任务是否完成；blocked 时读取问题并处理，需要用户输入则向用户说明；超时先检查状态和输出，不能直接重复分派。默认等成员可接收输入再发送下一条指令。

成员直接在自己的 Agent 会话中回复，Leader 通过 Herdr 读取。长结果可以写成 Markdown 文件，回复绝对路径。无需成员主动向正在执行的 Leader 注入消息。

## 实现范围

插件只需 `herdr-plugin.toml` 和一个初始化程序。程序负责解析 Markdown、创建 panes、在同一项目目录启动 Agent、注入指令和聚焦 Leader；日常协作由 Leader 使用 Herdr 完成。

保留一份小的启动结果文件，记录项目目录、本次创建的成员名称和 pane，便于部分启动失败时说明已启动的成员。重复初始化发现当前项目已有存活团队时，聚焦已有 Leader，避免再次启动。

不实现后台控制器、任务数据库、消息队列、自定义通信协议、管理面板或自动恢复。第一版仅要求固定成员启动成功，并能在 Leader 的指挥下协作完成一次开发任务。

依据：本机 Herdr 0.9.3 的 CLI 帮助，以及[插件文档](https://herdr.dev/docs/plugins/)和[Agent 自动化文档](https://herdr.dev/docs/agent-automation/)。使用 Go 实现并编译为独立可执行文件，入口为 `main.go`，安装和使用见 README.md。尚未在真实 Herdr 会话中启动团队。
