# Herdr Team

用 Markdown 定义 Agent 团队，在 Herdr 中启动后向 Leader 下达任务。成员在同一项目目录中工作，由 Leader 分配任务、协调修改和检查结果。

## 安装

支持 macOS/Linux，需要 Herdr 0.9.3+、Go 1.23+（编译时）和成员配置中使用的 Agent CLI。先在各 Agent CLI 中完成登录。

在本仓库目录执行：

```sh
go build -o bin/herdr-team .
herdr plugin link "$PWD"
```

`plugin link` 不会自动编译。插件编译后是独立可执行文件。

## 定义团队

在目标项目中，从 Herdr action palette 选择 **Initialize project Herdr Team**，或执行：

```sh
/path/to/herdr-team --init
/path/to/herdr-team --init --template fullstack --project /path/to/your-project
/path/to/herdr-team --list-templates
```

初始化会创建 `.team/`，不会启动 Agent，也不会覆盖已有的 `.team`。

| 模板 | 成员（均包含 Leader） | 用途 |
| --- | --- | --- |
| `minimal` | Developer | 小任务、快速修复 |
| `development`（默认） | Developer、Reviewer | 开发与评审 |
| `product` | Product Manager、Architect、Developer、QA | 需求、架构、开发与验收 |
| `fullstack` | Designer、Frontend、Backend、Reviewer | 前后端与界面开发 |
| `research` | Researcher、Analyst、Reviewer | 调研与分析 |
| `content` | Researcher、Writer、Editor | 文章与教程 |
| `data-analysis` | Data Engineer、Analyst、Reviewer | 数据整理与分析 |
| `security` | Auditor、Developer、Reviewer | 安全审查与修复 |

团队文件结构：

```text
.team/
  TEAM.md
  members/
    leader.md
    developer.md
    reviewer.md
```

`TEAM.md` 定义团队名称、Leader 和成员文件，正文填写团队规则：

```markdown
---
name: development-team
leader: leader
members:
  - members/leader.md
  - members/developer.md
  - members/reviewer.md
---
共享文件的修改由 Leader 协调。
```

成员文件定义 Agent 类型、启动参数和角色指令：

```markdown
---
id: developer
kind: codex
args: []
---
负责实现 Leader 分配的开发任务。
```

模板默认使用 Codex，可改为 Herdr 支持的其他 Agent 或混合使用。`args` 原样传给 Agent，成员需要能执行 shell 命令。成员 ID 为 1–20 个小写字母、数字、下划线或连字符，以字母开头；成员文件路径相对于 `.team/`，且必须位于其中。

编辑后可离线检查配置：

```sh
bin/herdr-team --check --project /path/to/your-project
```

## 自定义模板

模板结构与 `.team/` 相同，可以直接指定目录：

```sh
bin/herdr-team --init --template ./my-template --project /path/to/your-project
```

也可以集中存放模板，每个子目录是一个模板，例如 `my-templates/backend/TEAM.md`：

```sh
bin/herdr-team --init --templates-dir ./my-templates --template backend
bin/herdr-team --list-templates --templates-dir ./my-templates
```

`HERDR_TEAM_TEMPLATES_DIR` 设置默认模板目录，`--templates-dir` 优先。按名称查找时，用户模板优先于内置模板。初始化直接复制内容，不替换字符串；模板不支持符号链接或特殊文件，源目录不能等于或包含目标项目目录。

## 启动与使用

在 Herdr 中进入目标项目，从 action palette 选择 **Start project Herdr Team**，或在该项目的 Herdr pane 中执行：

```sh
herdr plugin action invoke local.herdr-team.start-team
```

插件创建团队 tab、启动成员并发送角色指令，完成后聚焦 Leader。初始化期间请勿向成员发送额外指令。

向 Leader 输入任务，例如：

> 实现登录功能，让 developer 开发、reviewer 评审，你负责协调和最终验证。

Leader 通过 `herdr agent prompt/wait/read` 分派任务、收集结果。pane 使用成员 ID 命名，协作命令使用带实例前缀的完整 Agent 名称，如 `t255aaa28-leader`。

所有成员共享项目目录，插件不创建 worktree、分支或文件锁。重叠修改需要由 Leader 协调。

再次启动会复用已就绪的团队并聚焦 Leader。修改 `.team/` 后，需结束旧团队再启动。

## 启动失败

登录、信任或权限提示需要在对应 pane 中手动处理。部分启动失败会保留已创建的成员，并报告启动记录的位置。检查记录、关闭该团队的 panes 后，再重新启动。若创建 tab 超时，先检查 Herdr 中是否已创建团队 tab，清理后删除错误记录再启动。

启动记录保存在 `HERDR_PLUGIN_STATE_DIR`，未设置时使用 `~/.local/state/herdr-agent-team`。移动项目或更改插件 ID 后，旧记录不会自动迁移，重新启动前请检查并关闭旧团队。

## 开发

```sh
go test ./...
go test -race ./...
go vet ./...
```

测试使用模拟 Herdr，不启动真实 Agent。端到端验证需在 Herdr 中启动团队并执行任务。

角色分工参考了 [MetaGPT](https://github.com/FoundationAgents/MetaGPT)、[Agency Agents](https://github.com/msitarzewski/agency-agents) 和 [CrewAI examples](https://github.com/crewAIInc/crewAI-examples)。模板由本项目编写，无需安装这些框架；可用工具和权限取决于各 Agent 的配置。
