# Herdr Team

在 Herdr 中一键启动 Agent 团队，用 Markdown 定义角色与协作规则。向 Leader 描述目标，由它分派任务、协调成员、组织评审并验证结果。

## 功能

- **团队协作**：成员共享项目目录，由 Leader 协调开发、评审和验证。
- **灵活配置**：自定义成员角色、Agent 类型和启动参数，支持混合使用 Herdr 支持的 Agent。
- **开箱即用**：内置 8 类团队模板，也可使用自己的模板。
- **便捷启动**：自动创建团队标签页和成员窗格，完成初始化后聚焦 Leader；再次启动会复用已就绪的团队。
- **配置检查**：启动前可离线检查团队定义。
- **启动诊断**：显示成员初始化进度，查询启动阶段和实时状态；配置变更后提示旧团队仍使用启动时的配置。

## 安装

支持 macOS 和 Linux。需要 Go 1.23+，以及已安装并登录的 Agent CLI（模板默认使用 Codex）。运行环境可选择 **herdr-core**（以官方 0.1.21 发布的 OpenRPC 接口为基准）或旧版 **Herdr 0.9.3+** 插件。

### 使用 herdr-core

克隆本仓库后构建，可从普通终端或 core 终端启动，无需旧版 Herdr 插件和工作区上下文：

```sh
go build -o bin/herdr-team .
bin/herdr-team --init --template minimal --project /absolute/project/path
bin/herdr-team --backend core --project /absolute/project/path
bin/herdr-team --backend core --status --project /absolute/project/path
```

启动完成后，执行输出中的 `herdr-core attach <leader-name>` 与 Leader 对话。core 后端创建持久终端，不创建标签页或窗格，也不自动切换当前终端。成员的 `kind` 是 core 运行环境 PATH 中的交互式 Agent 命令，`args` 作为启动参数传入；Codex 自动添加 `--no-daemon`。Agent 必须报告 OSC 7501 状态，启动后进入 `idle` 或 `done`，才能发送角色提示。不要配置一次性执行或退出模式。

底层通过 `herdr-core connect` 使用[官方 JSON-RPC API](https://github.com/herdrdev/herdr-core/blob/master/schema/README.md)，读取完整终端身份、状态和标签。角色提示发送一次，随后使用固定 caller 身份等待本轮处理；收到消息或等待超时检查点时继续等待，总就绪与启动稳定预算为 60 秒、发送后的等待预算为 120 秒。若 core 明确返回启动画面未稳定且 `nothing was typed`，会在预算内重新核验身份和状态后重试；其他发送错误不重试。成员协作使用启动时返回的终端地址，避免名称复用后发送到其他终端。

`--backend auto` 为默认值：`HERDR_ENV=1` 时使用旧版 Herdr，否则使用 core；可显式指定 `--backend core` 或 `--backend herdr`。core 默认调用 `herdr-core`，可通过 `HERDR_CORE_BIN_PATH` 指定绝对路径（包括名为 `hc` 的安装）。省略 `--project` 时使用当前目录；`--init`、`--check`、`--list-templates` 仍支持离线使用。

初始化消息只安装角色：成员应仅回复 `<角色> ready.` 并结束本轮，不执行工具、不发送就绪消息、不运行 `herdr-core wait`。真正收到任务后才开始协作；成员完成任务并汇报后结束本轮，由 Leader 发送下一条任务唤醒。若出现 `blocked: permission`，报错会给出 `attach` 命令，需要人在对应终端处理；插件不会自动批准。

团队状态按 core 的永久身份和项目路径隔离，重启 core 后仍可复用已启动的团队。再次启动不会重发角色提示；配置变更会提示旧团队仍使用原配置。部分启动失败时保留终端与记录，通过 `--status` 和 `herdr-core get/read <name>` 排查，只关闭该团队的终端后再重新启动。core 不会自动回答登录或权限提示。

### 使用旧版 Herdr 插件

额外需要 Git 和 Herdr 0.9.3+。

在任意目录执行：

```sh
herdr plugin install dyxu/herdr-team
```

Herdr 会拉取仓库、执行构建并注册插件，无需手动克隆或编译。插件安装后可在各个 Herdr 会话中使用，团队按项目单独配置和启动。

本地开发时，在本仓库目录手动构建后关联：

```sh
go build -o bin/herdr-team .
herdr plugin link "$PWD"
```

`plugin link` 不会执行构建。插件机制详见 [Herdr 插件文档](https://herdr.dev/docs/plugins/)。

## 使用

1. 在 Herdr 中打开并选中要协作的项目工作区。
2. 从 action palette 选择 **Initialize project Herdr Team**，在该项目中生成 `.team/`，默认包含 Leader、Developer 和 Reviewer。
3. 按需编辑 `.team/team.md` 中的团队规则，以及 `.team/members/` 下的角色、Agent 类型和启动参数。
4. 选择 **Start project Herdr Team**。插件会创建团队标签页、启动成员并初始化角色，完成后聚焦 Leader。
5. 向 Leader 描述任务，由它协调成员完成工作。

例如：

> 实现登录功能，让 developer 开发、reviewer 评审，你负责协调和最终验证。

也可以在目标项目的 Herdr 窗格中调用相同的 actions：

```sh
# 初始化项目团队（首次使用）
herdr plugin action invoke herdr-team.init-team

# 启动团队
herdr plugin action invoke herdr-team.start-team
```

初始化只生成配置，不启动 Agent；已有 `.team/` 时会保留原配置并拒绝覆盖。团队启动完成前，请等待角色初始化结束。

所有成员共享项目目录，文件修改和 Git 操作由 Leader 协调。再次启动会复用已就绪的团队；修改团队配置后会提示已有团队仍使用旧配置，需要关闭旧团队再启动。历史启动记录若没有配置摘要，会提示无法比较配置。成员出现登录或权限提示时，在对应窗格中处理。

启动时显示成员就绪检查、角色初始化及完成进度。角色初始化前，对启动中或暂时不可交互的成员最多等待 30 秒；正在工作、身份变化或需要用户输入的成员不会收到初始化提示。启动失败会保留窗格与状态，不会自动重启或重发可能已送达的提示。

可从 action palette 选择 **Show project Herdr Team status**，或执行：

```sh
herdr plugin action invoke herdr-team.status-team
```

状态查询显示启动阶段、失败原因、各成员的启动与初始化记录、实时状态和处理建议，不修改团队。也可在目标项目的 Herdr 窗格中使用 `bin/herdr-team --status --project /absolute/project/path`（二进制路径需指向插件安装目录）。

## 团队模板

所有模板均包含 Leader。

| 模板 | 用途 |
| --- | --- |
| `minimal` | 小任务、快速修复 |
| `development`（默认） | 开发与代码评审 |
| `product` | 需求、架构、开发与验收 |
| `fullstack` | 设计、前端与后端开发 |
| `research` | 调研、分析与评审 |
| `content` | 研究、写作与编辑 |
| `data-analysis` | 数据整理、分析与验证 |
| `security` | 安全审查与修复 |

在目标项目的 Herdr 窗格中调用以下 actions，也可从 action palette 选择对应操作：

```sh
# 查看可用模板
herdr plugin action invoke herdr-team.list-templates

# 为目标项目创建全栈团队
herdr plugin action invoke herdr-team.init-fullstack

# 检查团队配置
herdr plugin action invoke herdr-team.check-team
```

操作使用当前项目上下文，初始化不会覆盖已有的 `.team/`。自定义模板与 `.team/` 使用相同的目录结构；指定其他内置模板或自定义模板目录仍需使用可执行文件的 `--init --template` 参数，Herdr action 调用不支持追加参数。

更多配置与协作说明见 [DESIGN.md](DESIGN.md)，自动检查和真实环境验证流程见 [验证与故障排查](docs/verification.md)。
