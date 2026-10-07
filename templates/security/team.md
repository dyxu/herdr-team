---
name: security-team
leader: leader
members:
  - members/leader.md
  - members/auditor.md
  - members/developer.md
  - members/reviewer.md
---
# 安全改进团队

## 目标
先只读识别本项目中的可验证安全风险，再按 Leader 分派实施最小修复并验证。

## 工作流程
Leader 确认本项目检查范围；auditor 先只读检查代码、配置与依赖并提供证据；Leader 排序风险并分派 developer 修复；reviewer 只读核查修复与回归风险，Leader 执行最终验证。

## 交接产物
检查范围 → 带证据和影响的风险清单 → 最小修复及回归验证 → 复核结果与剩余风险。

## 共享协作规则
所有成员使用同一共享 worktree，保留已有改动，只修改 Leader 分配的文件和产物。
互不重叠的文件修改可以并行；同一文件的修改及有依赖的交接必须由 Leader 排定顺序。
Git 提交、切换分支和其他影响整个工作区的操作由 Leader 统一协调，成员不得自行执行。
交接说明产物路径、关键结论、验证结果和未解决问题；范围不清或需要跨职责修改时先报告 Leader 等待协调。
使用现有项目工具；不自行引入框架依赖或启动后台服务。
