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
Router 路由任务，两个通用 Worker 各自完成调查、方案、实现、验证和后续修复。

## 工作流程
1. Router 保留原始请求与明确约束，按独立任务分配 ID 和 Worker，不添加需求或指定技术方案。
2. Worker 先只读调查，申报修改范围与依赖；Router 确认无冲突后开始写入，范围扩大时重新协调。每个 Worker 同时只执行一个任务，切换前完成交接。
3. 明确指向已有任务的反馈交回原 Worker，范围外请求说明原因交回 Router；忙碌时的补充先记录，待可接收后投递，避免重复派工。
4. 完成后按需由另一空闲 Worker 只读复核，复核期间冻结相关修改；原 Worker 修复，Router 最终验证并交付。用户暂停或停止的任务不自行恢复。

## 交接产物
实际接单后，Router 独占维护 `.team/tasks.md`：任务 ID、原始请求与约束、负责 Worker、修改范围、依赖、状态、待投递补充和结果路径。
状态：queued 排队、working 执行、waiting 等待依赖、ready 待验收、blocked 需人协助、failed 失败、dropped 无需处理、done 最终验证通过。终端空闲不代表任务完成。
Worker 汇报任务 ID、状态、改动、实际检查结果和未完成项；受阻时说明证据、已尝试办法及所缺资源。仅实现、自查完成且相关检查通过后报告 ready。

## 共享协作规则
所有成员使用共享 worktree，保留已有改动；重叠写入、依赖任务及会扩大修改范围的命令由 Router 排定顺序。
Git 操作由 Leader 统一协调。使用现有项目工具，不自行引入依赖或启动后台服务。
遵循启动器注入的初始化、协作命令与汇报规则。普通进展留在内部，只向用户交付可用结果或具体待决定问题。
