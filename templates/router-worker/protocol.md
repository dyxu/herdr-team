# 任务交接协议

仅在收到实际开发任务后读取和使用本协议。将示例中的 `herdr-team` 替换为启动提示给出的 Task ledger CLI；路径参数有空格时正确引用。命令是元数据管理，不会自动派发消息或停止终端。

## Router

1. 将用户原始请求和明确约束原样写入任务请求文件，例如 `.team/reports/T001-request.md`，创建 `task create T001 worker-a <请求文件>`。任务卡的原文保持不变。
2. 已知修改范围直接写 scope JSON（`allowed_paths`、`dependencies`），运行 `task scope T001 1 <范围文件>`。该操作升级版本；把 `task show T001` 输出的完整当前任务卡交给 Worker，不要求其重复申报相同范围。未知范围时先分派只读调查。
3. 同一文件及其目录的范围不能与其他未完成任务重叠；ready 阶段仍保留范围供只读复核，done 后释放。Worker 的 ready 报告释放执行槽，但尚未通过最终验收。
4. 明确属于当前任务的反馈用 `task feedback T001 <版本> <反馈文件>` 记录，忙碌时不重复投递；其他需求另建任务。反馈不会解除暂停。
5. 改派前确认原 Worker 停止写入并完成交接。handoff JSON 包含 `summary`、`remaining`、`context_files` 和真实的 `worker_released: true`；运行 `task assign T001 <版本> worker-b <交接文件>`，将升级后的完整卡片交给新 Worker。working 状态不能直接改派或改范围，先收集 waiting/ready 等交接报告。
6. 让另一空闲 Worker 按风险只读复核，或由负责 Worker 执行耗时集成验证。先运行 `task audit T001` 核对 Git 基线、实际变化和漏报；共享目录的范围外变化不能直接认定由当前 Worker 造成。没有 Git 基线或 HEAD 改变时人工检查实际 diff。依据实际证据写最终 verification JSON（`summary`、`checks`、`remaining`）；只有检查全部 passed、无剩余项且当前 ready 报告已处理全部反馈，才 `task finish T001 <版本> <验证文件>`，随后 `task archive T001 <版本>`。

## Worker

- 新任务先读 `task show T001` 的完整原文、授权范围、依赖、反馈和交接。原文和版本不能由路由摘要替代，不沿用上一个任务的隐含假设。
- 检查依赖 done 后，提交 working 报告再写入。范围内常规选择自主解决；新增写入范围先向 Router 交接，得到新版本任务卡后再执行。
- 写报告 JSON，例如 `.team/reports/T001-worker-a.json`：

```json
{
  "status": "ready",
  "summary": "用户可见结果",
  "changed_files": ["src/example.ts"],
  "checks": [{ "command": "实际运行的检查", "result": "passed" }],
  "remaining": [],
  "seen_feedback": 0
}
```

- `status` 使用 working、waiting、ready、blocked、failed 或 dropped；`checks.result` 使用 passed、failed 或 not_run，不能编造运行结果。ready 要求至少一项相关检查全部通过且无未完成项，检查也可为有明确证据的人工复核。
- `seen_feedback` 必须等于最新任务卡中 feedback 的条数，表示这些反馈已读取并处理。汇报前重新读取卡片；提交 `task report T001 <版本> worker-a <报告文件>`，通过后再按当前后端规则通知 Router。过期版本、错误 Worker 或范围外改动会被拒绝。
- 只读复核不改实现，也不运行会修改文件的命令；报告范围与证据。复核意见交 Router 安排原 Worker 修复。

## 暂停与恢复

Router 先通知 Worker 停止写入，再 `task pause T001 <版本>`；暂停升级版本，旧报告失效。只有用户解除暂停后才 `task resume T001 <版本>` 并交付新版本卡片。命令本身不控制终端或沙箱，不能用元数据代替实际停止确认。

## 存储与边界

`task list` 输出活动任务摘要，`task show T001` 展开完整卡片及最近报告，已归档任务仍可查看。旧手工 `.team/tasks.md` 在首次生成索引前保存到任务目录中的 legacy-index 文件。历史报告保留在 reports 子目录，不全部塞入启动提示或活动索引。

控制记录由 CLI 原子写入并以任务目录锁串行更新；`task lock inspect` 可诊断，`task lock recover` 只恢复确认已退出的本机进程留下的锁。任务版本校验不是身份认证，元数据范围不是操作系统文件锁；实际文件编辑、消息投递和外部权限仍由 Agent 遵守团队规则。

任务卡是权威数据，`tasks.md` 是派生索引。遇到 `index_warning` 时任务已经提交，不重放原操作；修复索引路径后用 `task reindex` 重建。`task show` 的 `last_report_current` 为 false 时只把 `historical_report` 当作历史背景，不当作当前交付。
