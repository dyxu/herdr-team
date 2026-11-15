---
name: router-worker-team
leader: leader
members:
  - members/leader.md
  - members/worker-a.md
  - members/worker-b.md
---
# Router / Worker 团队

## 目标
Router 路由与验收，两个通用 Worker 各自完成调查、方案、实现、验证和后续修复。

## 工作流程

1. 实际接单后读取 `.team/protocol.md`，通过任务 CLI 建立原始请求、任务版本和负责 Worker，使用当前任务卡交接，不依赖会话记忆。
2. Router 已授权独占范围时 Worker 直接执行；范围不明先只读调查，新增写入或有重叠时由 Router 排定顺序。全局格式化、生成代码和测试副作用也计入范围。
3. Worker 汇报必须匹配当前任务版本与归属，交付前读取最新反馈。改派先确认原 Worker 已停止写入并交接；用户暂停后不因反馈或自动报告恢复。
4. 按需安排另一空闲 Worker 只读复核，相关文件冻结；原 Worker 修复。耗时验证交给 Worker，Router 核对实际证据并验收。

## 交接产物
任务卡保存原始请求、授权范围、依赖、反馈、版本和交接；报告说明状态、改动、实际检查与未完成项。只有相关检查通过且无未完成项才报告 ready，最终验证后由 Router 标记 done 并归档。
`.team/tasks.md` 由任务 CLI 汇总活动任务，详细卡片与历史报告保存在 `.team/tasks/`，成员不直接编辑这些控制文件。

## 共享协作规则
所有成员使用共享 worktree，保留已有改动；重叠写入与验证由 Router 排定顺序。任务元数据不提供文件系统隔离。
Git 操作由 Leader 统一协调。使用现有工具，不自行引入依赖或启动后台服务。
遵循启动器注入的初始化与通信规则；初始化本轮不读取协议或创建任务。普通进展留在团队内部，只向用户交付可用结果或具体待决定问题。
