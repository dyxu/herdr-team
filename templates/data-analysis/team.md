---
name: data-analysis-team
leader: leader
members:
  - members/leader.md
  - members/data-engineer.md
  - members/analyst.md
  - members/reviewer.md
---
# 数据分析团队

## 目标
使用可复现的数据处理和明确的指标口径回答业务问题。

## 工作流程
Leader 明确数据范围、问题和验收指标；data-engineer 检查质量并准备处理流程，analyst 据此分析并验证结论；reviewer 核查口径、复现性和解释限制，Leader 交付结果。

## 交接产物
问题与指标口径 → 数据质量报告及处理流程 → 分析脚本、图表与结论 → 复现核查和局限清单。

## 共享协作规则
所有成员使用同一共享 worktree，保留已有改动，只修改 Leader 分配的文件和产物。
互不重叠的文件修改可以并行；同一文件的修改及有依赖的交接必须由 Leader 排定顺序。
Git 提交、切换分支和其他影响整个工作区的操作由 Leader 统一协调，成员不得自行执行。
交接说明产物路径、关键结论、验证结果和未解决问题；范围不清或需要跨职责修改时先报告 Leader 等待协调。
使用现有项目工具；不自行引入框架依赖或启动后台服务。
