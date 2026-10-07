---
name: product-team
leader: leader
members:
  - members/leader.md
  - members/product-manager.md
  - members/architect.md
  - members/developer.md
  - members/qa.md
---
# 产品交付团队

## 目标
将用户需求落实为范围明确、可验收的产品改动。

## 工作流程
Leader 确认目标和约束；product-manager 定义需求与验收条件，architect 据此确定接口与实现边界；developer 实现，qa 依据验收条件验证并向 Leader 反馈缺陷；Leader 安排返工和最终验收。

## 交接产物
需求说明与验收清单 → 架构决策和接口约定 → 实现及验证记录 → 测试结果与缺陷清单。

## 共享协作规则
所有成员使用同一共享 worktree，保留已有改动，只修改 Leader 分配的文件和产物。
互不重叠的文件修改可以并行；同一文件的修改及有依赖的交接必须由 Leader 排定顺序。
Git 提交、切换分支和其他影响整个工作区的操作由 Leader 统一协调，成员不得自行执行。
交接说明产物路径、关键结论、验证结果和未解决问题；范围不清或需要跨职责修改时先报告 Leader 等待协调。
使用现有项目工具；不自行引入框架依赖或启动后台服务。
