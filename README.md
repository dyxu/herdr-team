# Herdr Team

在 Herdr 中一键启动 Agent 团队，用 Markdown 定义角色与协作规则。向 Leader 描述目标，由它分派任务、协调成员、组织评审并验证结果。

## 功能

- **团队协作**：成员共享项目目录，由 Leader 协调开发、评审和验证。
- **灵活配置**：自定义成员角色、Agent 类型和启动参数，支持混合使用 Herdr 支持的 Agent。
- **开箱即用**：内置 8 类团队模板，也可使用自己的模板。
- **便捷启动**：自动创建团队标签页和成员窗格，完成初始化后聚焦 Leader；再次启动会复用已就绪的团队。
- **配置检查**：启动前可离线检查团队定义。

## 安装

支持 macOS 和 Linux。需要 Herdr 0.9.3+、Git、Go 1.23+，以及已安装并登录的 Agent CLI（模板默认使用 Codex）。

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

所有成员共享项目目录，文件修改和 Git 操作由 Leader 协调。再次启动会复用已就绪的团队；修改团队配置后，需要关闭旧团队再启动。成员出现登录或权限提示时，在对应窗格中处理。

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

更多配置与协作说明见 [DESIGN.md](DESIGN.md)。
