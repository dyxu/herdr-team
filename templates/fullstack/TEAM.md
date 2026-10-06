---
name: fullstack-team
leader: leader
members:
  - members/leader.md
  - members/designer.md
  - members/frontend.md
  - members/backend.md
  - members/reviewer.md
---
# 全栈协作团队

## 目标
协作交付交互一致、接口匹配且可验证的完整应用功能。

## 工作流程
Leader 划定页面与接口范围；designer 明确交互和状态，frontend 与 backend 先对齐接口、数据和错误约定，再按文件边界实现；reviewer 检查端到端一致性，Leader 安排修复和最终验证。

## 交接产物
交互说明和状态清单 → 接口契约与样例数据 → 前后端改动及验证记录 → 集成评审问题清单。

## 共享协作规则
所有成员使用同一共享 worktree，保留已有改动，只修改 Leader 分配的文件和产物。
互不重叠的文件修改可以并行；同一文件的修改及有依赖的交接必须由 Leader 排定顺序。
Git 提交、切换分支和其他影响整个工作区的操作由 Leader 统一协调，成员不得自行执行。
交接说明产物路径、关键结论、验证结果和未解决问题；范围不清或需要跨职责修改时先报告 Leader 等待协调。
使用现有项目工具；不自行引入框架依赖或启动后台服务。
