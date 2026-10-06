# Herdr Agent Team

一个轻量 Herdr 插件：按 `.team` 中的 Markdown 定义启动团队，之后直接向 Leader 下达开发指令。所有成员在当前项目的同一个 worktree 中工作，通信使用 Herdr。没有后台服务或任务数据库。

## 安装

需要 macOS/Linux、Go 1.23+（编译时）、Herdr 0.9.3+，以及团队中配置的 Agent 程序。先在各 Agent 自己的 CLI 中完成登录与必要设置。编译后的插件是独立 Go 可执行文件。

在插件源码目录执行：

```sh
go build -o bin/agent-team .
herdr plugin link "$PWD"
```

构建时下载 YAML 解析依赖；`plugin link` 不会自动执行 build。发布到 GitHub 后也可用 `herdr plugin install owner/repo` 安装，manifest 的 build 会编译插件。

## 定义团队

将本仓库的 `.team/` 复制到你的项目，编辑各成员的 `kind` 和 `args`。示例默认使用 Codex，只是示例配置；可使用 Herdr 支持的其他类型或混合类型。

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
bin/agent-team --check --project /path/to/your-project
```

## 启动与使用

在 Herdr 中进入目标项目，从 action palette 选择 **Start project agent team**。也可以在该项目的 Herdr pane 中执行：

```sh
herdr plugin action invoke local.agent-team.start-team
```

插件从当前 workspace/worktree 上下文取得项目目录，创建团队 tab，启动成员，注入角色和协作说明，最后聚焦 Leader。每个 pane 的名称与对应 Agent 的完整名称一致（包含团队实例前缀）。所有 panes 使用同一项目目录；不会创建 worktree 或 Git 分支。初始化程序随后退出。

直接向 Leader 输入：

> 实现登录功能，让 developer 开发、reviewer 评审，你负责协调和最终验证。

Leader 通过 `herdr agent prompt/wait/read` 分派并收集工作。共享文件的修改应由 Leader 协调，避免重叠；这属于协作指令，不是文件锁或权限隔离。

再次启动已有完整团队会聚焦原 Leader，不重新注入提示。修改定义后，要结束旧团队再启动，才能应用新定义。

## 启动失败

登录、信任或权限对话需要在对应 pane 中由你处理。插件不自动批准。部分启动失败会保存已创建的成员和 pane，退出并报告启动记录的位置；不会自动关闭已有进程，也不会重复提交不确定的提示。

第一版没有自动恢复：检查启动记录，手动关闭其中的团队 panes，然后重新启动。如果创建 tab 的请求超时而未返回 ID，先在 Herdr 中检查是否已创建团队 tab，清理后删除错误记录再启动。

启动记录在 `HERDR_PLUGIN_STATE_DIR` 中；直接运行二进制时默认使用 `~/.local/state/herdr-agent-team`。记录按 Herdr socket、workspace 和项目路径隔离。初始化锁只覆盖启动阶段，没有常驻进程。

## 开发与验证

```sh
go test ./...
go vet ./...
```

测试通过模拟 Herdr 验证完整初始化、共享目录、提示注入、重复启动和部分失败，不创建真实 Agent。真实端到端验证需要在 Herdr 中启动配置好的 Agent，并向 Leader 下达一个开发任务。
