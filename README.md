# Herdr Team

用 Markdown 定义 Agent 团队，由 Leader 分派任务、协调开发与评审，并验证结果。支持 herdr-core 和旧版 Herdr 插件，所有成员共享同一个项目目录。

## 快速开始：herdr-core

支持 macOS 和 Linux。需要 Go 1.23+、herdr-core（已验证 0.1.21），以及已安装并登录的 Agent CLI，默认使用 Codex。

在本仓库目录构建，指定要协作的项目：

```sh
go build -o bin/herdr-team .
team="$PWD/bin/herdr-team"
project="/absolute/project/path"

# 首次使用：创建 Leader、Developer、Reviewer 团队
"$team" --init --project "$project"

# 启动团队
"$team" --backend core --project "$project"
```

已有 `.team/` 时跳过 `--init`。在目标项目目录调用二进制时，可省略 `--project`。

等待输出 `Team ready`，执行输出中的 `herdr-core attach <leader-name>` 进入 Leader，然后描述任务，例如：

> 实现登录功能，让 developer 开发、reviewer 评审，你负责协调和最终验证。

初始化期间，成员只回复角色就绪；收到实际任务后才开始工作。再次启动会复用已有团队。

## 配置与模板

- `.team/team.md`：团队规则、Leader 和成员名单。
- `.team/members/*.md`：成员职责、Agent 命令 `kind` 和启动参数 `args`。

自定义 Agent 需支持 OSC 7501 状态上报，并保持交互运行。修改配置后，关闭旧团队再启动才能生效。

默认模板为 `development`；首次初始化时可加 `--template minimal` 创建两人团队，或选择其他模板。

```sh
# 查看可用模板
"$team" --list-templates

# 检查当前团队配置
"$team" --check --project "$project"
```

## 状态与故障处理

```sh
"$team" --backend core --status --project "$project"
```

- **启动画面未稳定**：插件会对明确未输入的角色提示自动重试，等待结果即可。
- **权限、登录或问题确认**：按报错中的 attach 命令进入对应终端手动处理。
- **提示可能已送达**：先查看终端画面，不要盲目重发。
- **上次团队启动不完整**：根据状态记录，只关闭该失败团队的终端后重试；不要只删除记录而保留旧终端。

## 旧版 Herdr 插件

需要 Git 和 Herdr 0.9.3+：

```sh
herdr plugin install dyxu/herdr-team
```

在 Herdr 中选中目标项目，从 action palette 依次选择 **Initialize project Herdr Team** 和 **Start project Herdr Team**；已有 `.team/` 时跳过初始化。启动完成后向 Leader 描述任务。

`--backend auto` 为默认值：旧版 Herdr 环境使用插件后端，其他环境使用 core。也可用 `--backend core` 或 `--backend herdr` 显式指定。

详细配置见 [DESIGN.md](DESIGN.md)，验证流程和更多排查步骤见 [验证与故障排查](docs/verification.md)。
