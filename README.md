# Herdr Team

一个轻量 Herdr 插件：按 `.team` 中的 Markdown 定义启动团队，之后直接向 Leader 下达开发指令。所有成员在当前项目的同一个 worktree 中工作，通信使用 Herdr。没有后台服务或任务数据库。

## 安装

需要 macOS/Linux、Go 1.23+（编译时）、Herdr 0.9.3+，以及团队中配置的 Agent 程序。先在各 Agent 自己的 CLI 中完成登录与必要设置。编译后的插件是独立 Go 可执行文件。

在插件源码目录执行：

```sh
go build -o bin/herdr-team .
herdr plugin link "$PWD"
```

构建时下载 YAML 解析依赖；`plugin link` 不会自动执行 build。发布到 GitHub 后也可用 `herdr plugin install owner/repo` 安装，manifest 的 build 会编译插件。

## 定义团队

在目标项目中执行初始化命令，或从 Herdr action palette 选择 **Initialize project Herdr Team**：

```sh
/path/to/herdr-team --init
/path/to/herdr-team --init --template minimal --project /path/to/your-project
/path/to/herdr-team --list-templates
```

内置模板如下，默认使用 `development`。每个模板都有 Leader 协调、场景工作流程和角色交付要求；成员类型和参数仍可修改。

| 模板 | 成员 | 适用任务 |
| --- | --- | --- |
| `minimal` | Leader、Developer | 小任务、快速修复 |
| `development` | Leader、Developer、Reviewer | 日常开发与评审（默认） |
| `product` | Leader、Product Manager、Architect、Developer、QA | 从需求、架构到实现和验收 |
| `fullstack` | Leader、Designer、Frontend、Backend、Reviewer | 前后端及界面协作 |
| `research` | Leader、Researcher、Analyst、Reviewer | 资料调研、证据整理和分析报告 |
| `content` | Leader、Researcher、Writer、Editor | 技术文章、教程与内容编辑 |
| `data-analysis` | Leader、Data Engineer、Analyst、Reviewer | 数据整理、可复现分析和结论复核 |
| `security` | Leader、Auditor、Developer、Reviewer | 项目代码安全审查、修复和验证 |

例如：

```sh
bin/herdr-team --init --template fullstack --project /path/to/your-project
```

内置模板随二进制发布。初始化只创建 `.team/`，不启动 Agent；已有 `.team`（包括文件或符号链接）时拒绝覆盖。模板先校验，再生成目录，失败不会留下半成品。

初始化后编辑各成员的 `kind`、`args` 和正文角色指令，以及 `TEAM.md` 的成员列表和团队规则。示例默认使用 Codex，可使用 Herdr 支持的其他类型或混合类型。也可继续手动复制本仓库的 `.team/`。

```text
your-project/
  .team/
    TEAM.md
    members/
      leader.md
      developer.md
      reviewer.md
```

`TEAM.md` 的 frontmatter 包含 `name`、`leader` 和成员文件路径列表 `members`。成员文件包含 `id`、`kind`、`args`，正文是角色指令。成员 ID 使用 1–20 个小写字母、数字、下划线或连字符，以字母开头；文件路径相对于 `.team/`，必须位于其中。

```markdown
---
id: developer
kind: codex
args: []
---
负责实现 Leader 分配的开发任务。
```

插件把 `args` 原样传给 Agent，不解释厂商参数。成员必须能执行 shell 命令。可以先离线检查配置：

```sh
bin/herdr-team --check --project /path/to/your-project
```

团队分工参考 [MetaGPT](https://github.com/FoundationAgents/MetaGPT) 的产品、架构、工程角色，[Agency Agents](https://github.com/msitarzewski/agency-agents) 的前后端、设计、安全与数据角色，以及 [CrewAI examples](https://github.com/crewAIInc/crewAI-examples) 的研究、内容协作场景。这里的团队组合和角色指令为本项目编写，适配 Herdr 的 Leader 协调与共享 worktree，不需要安装上述框架。调研成员使用当前 Agent 可用工具，模板不额外提供浏览器、数据连接或工具权限。

## 自定义模板

模板目录使用与 `.team/` 相同的结构，包含 `TEAM.md` 和成员 Markdown 文件。可以直接指定目录：

```sh
bin/herdr-team --init --template /path/to/my-template --project /path/to/your-project
```

也可以将多个模板放入一个目录，每个子目录名称就是模板名称，例如 `my-templates/backend/TEAM.md`：

```sh
bin/herdr-team --init --templates-dir /path/to/my-templates --template backend
bin/herdr-team --list-templates --templates-dir /path/to/my-templates
```

`HERDR_TEAM_TEMPLATES_DIR` 可设置默认模板目录，`--templates-dir` 优先于该环境变量。按名称选择时，先查用户模板，再查内置模板；用户模板可以覆盖同名内置模板；`--templates-dir=` 可清除环境变量设置。直接指定本地目录时建议使用 `./NAME` 或绝对路径。模板中的 `kind`、`args`、成员和指令都可配置，初始化复制模板内容，不做字符串替换。模板中的符号链接和特殊文件不支持；源模板目录不能等于或包含目标项目目录。

`--init`、`--check`、`--list-templates` 互斥；`--template` 用于初始化，`--templates-dir` 用于初始化或列出模板。离线初始化默认当前目录；在 Herdr 中未指定 `--project` 时使用当前项目上下文。

## 启动与使用

在 Herdr 中进入目标项目，从 action palette 选择 **Start project Herdr Team**。也可以在该项目的 Herdr pane 中执行：

```sh
herdr plugin action invoke local.herdr-team.start-team
```

插件从当前 workspace/worktree 上下文取得项目目录，创建团队 tab，启动成员，注入角色和协作说明，最后聚焦 Leader。每个 pane 使用成员 ID 命名，如 `leader`、`developer`、`reviewer`；Agent 的唯一名称仍包含团队实例前缀，如 `t255aaa28-leader`，Herdr 协作命令使用该完整名称。所有 panes 使用同一项目目录；不会创建 worktree 或 Git 分支。初始化程序随后退出。

普通成员的角色提示最多并行初始化 4 个；全部成功后再初始化 Leader。发送提示前检查成员身份、是否处于 idle/done 状态和是否可接收输入。Herdr 不跟踪提示对应的具体回合，检查与提交之间仍可能发生外部输入；初始化期间请勿向成员额外发送指令。

直接向 Leader 输入：

> 实现登录功能，让 developer 开发、reviewer 评审，你负责协调和最终验证。

Leader 通过 `herdr agent prompt/wait/read` 分派并收集工作。共享文件的修改应由 Leader 协调，避免重叠；这属于协作指令，不是文件锁或权限隔离。

再次启动已有完整团队会聚焦原 Leader，不重新注入提示。修改定义后，要结束旧团队再启动，才能应用新定义。

## 启动失败

登录、信任或权限对话需要在对应 pane 中由你处理。插件不自动批准。部分启动失败会保存已创建的成员和 pane，退出并报告启动记录的位置；不会自动关闭已有进程，也不会重复提交不确定的提示。

并行初始化中出现失败时，会收集已派出成员的结果，保留成功成员的初始化记录。若团队已经就绪，仅最后聚焦 Leader 失败，仍保留就绪状态；再次启动会复用团队并重试聚焦。

部分启动失败不自动恢复：检查启动记录，手动关闭其中的团队 panes，然后重新启动。如果创建 tab 的请求超时而未返回 ID，先在 Herdr 中检查是否已创建团队 tab，清理后删除错误记录再启动。

启动记录在 `HERDR_PLUGIN_STATE_DIR` 中；未设置该变量时，默认仍使用历史兼容路径 `~/.local/state/herdr-agent-team`，避免仅 CLI 改名改变默认状态目录。插件 ID 改变可能改变 Herdr 提供的状态目录，移动项目目录会改变启动记录的键；这些情况下不会自动迁移或识别旧记录，再次启动前应检查并关闭旧团队。记录按 Herdr socket、workspace 和项目路径隔离。初始化锁只覆盖启动阶段，没有常驻进程。

## 开发与验证

```sh
go test ./...
go test -race ./...
go vet ./...
```

测试通过模拟 Herdr 验证完整初始化、共享目录、提示注入、重复启动和部分失败，不创建真实 Agent。真实端到端验证需要在 Herdr 中启动配置好的 Agent，并向 Leader 下达一个开发任务。
