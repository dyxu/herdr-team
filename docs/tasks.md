# 任务账本

`herdr-team task <操作> ... [项目]` 管理共享目录中的任务元数据，不会自动投递消息、停止 Agent 或隔离文件系统。`help task` 列出所有操作。项目默认为当前目录，旧版 Herdr 中可沿用项目上下文。

## 生命周期

1. `task create T001 worker-a request.md` 原样保存请求，记录 Git 基线（没有 Git 或 HEAD 时标记不可用）。
2. `task scope T001 1 scope.json` 授权范围和依赖，版本升级为 2；把完整当前任务卡交给 Worker。
3. `task report T001 2 worker-a report.json` 提交 working、waiting、ready、blocked、failed 或 dropped 报告。
4. `task audit T001` 只读比较 Git 基线、实际变化和报告，检查范围外变化及漏报。
5. `task finish T001 2 verification.json` 检查当前 ready 报告、反馈和验证结果，保存独立 Git 核对快照。
6. `task archive T001 2` 归档完成或 dropped 的任务；`task show T001` 仍可查询。

scope.json：

```json
{"allowed_paths":["src/export.ts","test/export.test.mjs"],"dependencies":[]}
```

report.json：

```json
{
  "status":"ready",
  "summary":"修复导出编码",
  "changed_files":["src/export.ts","test/export.test.mjs"],
  "checks":[{"command":"实际执行的检查","result":"passed","details":"实际证据"}],
  "remaining":[],
  "seen_feedback":0
}
```

verification.json 包含 `summary`、`checks`、`remaining`；所有检查必须 passed 且无剩余项。CLI 不执行报告里的命令，不能用填写 passed 代替真实验证。工作范围发生重叠时拒绝授权；ready 阶段仍保留范围，最终 done 后释放。未完成的依赖会阻止 working/ready。

## 反馈、交接和暂停

- `task feedback T001 2 feedback.md` 保存补充原文；Worker 报告的 `seen_feedback` 必须等于任务卡中反馈条数。
- `task assign T001 2 worker-b handoff.json` 改派并升级版本。交接包含 `summary`、`remaining`、`context_files`、真实的 `worker_released: true`。working 状态必须先停止写入并报告交接状态。
- `task pause T001 2` 升级版本并记录暂停；先确认 Worker 已停止写入。`task resume T001 3` 只能在用户解除暂停后执行。
- 改范围、改派、暂停和恢复会升级版本。`task show` 的 `last_report_current` 表示报告版本、Worker 和反馈确认是否仍匹配；过期报告置于 `historical_report`，`last_report` 为 null。

## 存储、重建与诊断

任务卡是权威数据，位于 `.team/tasks/active/` 和 `archive/`。历史报告位于 `.team/tasks/reports/`。`.team/tasks.md` 只是派生索引，首次生成时备份旧手工内容。

如果操作结果包含 `index_warning`，任务已经提交，不要重放原操作。修复索引路径或权限后执行 `task reindex`，再用 `task show` 确认。归档成功但索引失败时也明确输出警告。进程中断或丢失命令响应时，先读卡核实是否提交，不能假设操作未生效。

`task lock inspect` 显示任务锁与 recovery guard 的 owner、进程状态和错误。`task lock recover` 仅恢复确认已退出的本机 owner；缺失 owner 或残留 guard 的人工恢复步骤见[验证指南](verification.md#启动目录锁残留)。

Git 核对是辅助证据：已有改动被单独列出；共享目录中其他 Worker 的改动也可能显示为范围外变化，无法据此证明作者。忽略文件不扫描，超大文件或 Git 不可用时明确标记不可用；HEAD 变化要求人工检查提交 diff。文件内容在检查过程中仍可能变化，因此最终验收前需冻结写入并检查实际产物。旧任务没有基线时继续可用，但不能声称已自动核对。

`doctor` 会同时核对活动任务的 Worker 是否存在及身份是否匹配；暂停或 working 任务对应空闲终端时提示人工核对，元数据不等同于真实执行状态。
