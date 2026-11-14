# 验证与故障排查

## 自动检查

```sh
go test -race -cover ./...
go vet ./...
go build -o bin/herdr-team .
```

GitHub Actions 在 macOS 和 Linux 上执行以上检查，并验证编译后二进制能列出模板、初始化和检查团队。CI 不启动真实 Agent，不需要厂商凭据。

## herdr-core 验证

自动测试通过独立 connect 子进程模拟官方 JSON-RPC 请求与完整 API 响应，并用仓库内保存的官方 0.1.21 发布 schema 校验实际请求参数。覆盖 idle/done 初始化、角色指令、Codex 参数、稳定 caller、状态查询、重复复用、配置变更、消息打断和 timeout 检查点后继续等待，启动 settle 拒绝后的安全重试、重试前 blocked/身份变化、重试预算，以及 blocked、启动响应丢失和发送失败后不重复启动或发送。send 返回 started=false 时仍等待同一轮处理。另覆盖错误响应、非法版本/ID、CLI 简略记录误入和总等待预算。初始化提示另验证所有角色在本轮禁止工具调用、发送就绪消息与执行 wait；模拟送达后 blocked:permission，检查 attach 诊断且无重发或 force。旧版 Herdr 测试继续运行。

真实 core 回归脚本不依赖 Agent 或厂商凭据：

```sh
go build -o bin/herdr-team .
python3 scripts/verify-core.py --core /absolute/path/to/herdr-core
```

脚本使用独立 socket、`HC_SESSION` 和临时 XDG 目录，运行报告 OSC 7501 状态的交互式 Python 测试程序。验证双成员团队在 idle/done 状态下初始化、角色提示各发送一次、状态查询和重复复用；通过先报告 idle、再持续输出 6.5 秒的 fixture 复现 core 的 5 秒 settle 拒绝，验证自动重试后每个角色只实际收到一次；通过向测试 caller 终端发送消息，验证真实 message 打断后继续等待且不重发。另模拟提示送达后报告 blocked:permission，确认状态为 partial、错误包含原因和 attach 指引、状态查询不会回答弹窗。结束时清理本次创建的终端与 core。2026-11-13 在 macOS、herdr-core 0.1.21 上全部通过；此验证未启动真实 Agent。

2026-11-13 另在本仓库的真实 `.team/` 配置下，以独立临时状态目录运行 `bin/herdr-team --backend core`，使用本机 herdr-core 0.1.21 和 Codex 0.169.0 启动 Leader、Developer、Reviewer。三个成员均完成初始化，分别只回复 `leader ready.`、`developer ready.`、`reviewer ready.`；读取画面未见额外工具调用或权限弹窗。Developer 的启动 settle 拒绝自动重试成功。随后 `--status` 和重复启动均通过，三个终端的地址与 turn=2 保持一致，没有新增成员或重发角色提示。本次仅验证启动、初始化、状态和复用，未分派实际开发任务。原失败团队保持不动，本次测试团队验证后单独清理。

已安装并登录交互式 Agent 后，可在独立测试项目中手动运行（会启动真实 Agent）：

2026-11-14 对 `router-worker` 精简提示词进行了真实 Codex 测试（macOS、herdr-core 0.1.21、Codex 0.169.0）。使用专用 socket、独立 XDG/插件状态目录及临时 Python 项目，三个成员均按要求只回复角色就绪；状态查询与重复启动复用同一组终端通过。随后向 Router 下发两个需要修改同一 `helpers.py` 的独立需求（空白规范化与数值截断），计划验证分派、重叠写入协调及最终 unittest 验证。Router 调用 `herdr-core get` 时被其自身 Codex 沙箱阻止，申请提权后进入权限确认；未自动回答弹窗，两个 Worker 尚未收到开发任务。因此本次仅能确认真实初始化与复用通过，端到端协作仍待通信权限获准后继续，不能视为已通过。现场与画面记录保留在 `/private/tmp/herdr-rw-live-d_9h4xjz/`（临时目录，非长期归档）。

```sh
plugin="$PWD/bin/herdr-team"
test_project="$(mktemp -d)"
test_state="$(mktemp -d)"
"$plugin" --init --template minimal --project "$test_project"
HERDR_PLUGIN_STATE_DIR="$test_state" "$plugin" --backend core --project "$test_project"
HERDR_PLUGIN_STATE_DIR="$test_state" "$plugin" --backend core --status --project "$test_project"
HERDR_PLUGIN_STATE_DIR="$test_state" "$plugin" --backend core --project "$test_project"
```

检查重复启动未新增终端或重发角色提示，按输出的 attach 命令进入 Leader。失败时用 `herdr-core get/read <name>` 检查，不自动处理授权，不盲目重发。结束后只对测试记录中的终端执行 kill/rm；不要停止或重启用户的 core。

## 真实 Herdr 验证

已登录 Agent 后，可在 Herdr 窗格中运行显式启用的集成测试：

```sh
HERDR_TEAM_INTEGRATION=1 go test -run '^TestHerdrIntegration$' -count=1 -v -timeout 6m .
```

该测试会启动两个真实 Agent，可能产生 API 费用；创建独立临时项目与状态目录，检查正常启动、状态查询、重复启动与配置变更提示，结束时关闭本次创建的测试标签页并恢复调用方标签页。默认测试和 CI 跳过该用例。登录、仓库信任或权限提示不会被自动回答，遇到时测试会失败并输出诊断。

在 Herdr 管理的窗格中执行，使用独立的临时项目和状态目录，避免复用现有团队。下面的 `plugin` 指向刚编译的本仓库二进制。

```sh
plugin="$PWD/bin/herdr-team"
test "${HERDR_ENV:-}" = 1
herdr status server
test_project="$(mktemp -d)"
test_state="$(mktemp -d)"
"$plugin" --init --template minimal --project "$test_project"
HERDR_PLUGIN_STATE_DIR="$test_state" "$plugin" --project "$test_project"
HERDR_PLUGIN_STATE_DIR="$test_state" "$plugin" --status --project "$test_project"
```

不要在未登录或需要授权的对话框中自动回答。启动若被阻塞，检查测试团队的对应窗格，记录诊断与状态输出；由用户处理登录或授权。

| 场景 | 操作 | 验收 |
| --- | --- | --- |
| 正常启动 | 使用已安装、已登录的 Agent 启动 minimal 团队 | 显示初始化进度，普通成员完成后初始化 Leader，最终为 ready |
| 重复启动 | 使用相同项目和状态目录再次运行 | 聚焦原 Leader，不新增团队或发送初始化提示 |
| 配置变更 | 修改临时项目中的角色正文，再次运行 | 提示当前团队仍使用旧配置，不自动重启 |
| 登录或权限阻塞 | 使用未登录的测试账号，或保留 Agent 的启动授权提示 | 报告失败与窗格处理建议，保留状态，不自动批准或重发 |
| 部分失败后重启 | 存在测试成员窗格时再次启动 | 阻止创建重复团队；关闭测试团队窗格后可重新启动 |
| 查询状态 | 运行 `--status` | 显示记录与实时状态，失败阶段及建议；不创建、聚焦或关闭窗格 |

测试结束后，只关闭本次创建的测试团队标签页。确认测试进程已退出后删除临时项目与状态目录。不要关闭其他团队或删除其他项目的启动记录。

## 本次验证记录（2026-11-03）

在本机 macOS、Herdr 客户端及服务端 0.9.5、Codex 环境运行显式启用的集成测试，正常启动、状态查询、重复启动复用和配置变更提示均通过，测试标签页已清理。登录/授权阻塞、部分失败、身份变化与超时路径由自动化模拟测试覆盖，未在真实账号上主动制造登录失败。Linux 验证由新增 CI 执行，本次未在本机执行 Linux 任务。

## 排查顺序

1. 使用 **Show project Herdr Team status** 或 `--status` 查看失败阶段和成员状态。
2. 对登录、权限或交互提示，进入对应成员窗格处理；不要直接重复提交角色提示。
3. 需要重新初始化时，先关闭该团队的旧窗格，再启动；确认配置修改已生效。
4. Herdr 兼容性报错时，查看 `herdr --version`、`herdr status server` 和 `herdr agent start --help`。客户端与服务端版本可能不同。
