---
name: research-team
leader: leader
members:
  - members/leader.md
  - members/researcher.md
  - members/analyst.md
  - members/reviewer.md
---
# 研究分析团队

## 目标
针对明确问题形成有来源、可追溯并区分证据与推断的研究结论。

## 工作流程
Leader 确认问题、时间范围和交付形式；researcher 收集一手资料并标注出处，analyst 比较证据和解释差异；reviewer 核查引文、逻辑与遗漏，Leader 汇总结论和不确定性。

## 交接产物
研究问题与资料范围 → 来源清单及事实摘记 → 论证与结论草稿 → 核查意见和证据缺口。

## 共享协作规则
所有成员使用同一共享 worktree，保留已有改动，只修改 Leader 分配的文件和产物。
互不重叠的文件修改可以并行；同一文件的修改及有依赖的交接必须由 Leader 排定顺序。
Git 提交、切换分支和其他影响整个工作区的操作由 Leader 统一协调，成员不得自行执行。
交接说明产物路径、关键结论、验证结果和未解决问题；范围不清或需要跨职责修改时先报告 Leader 等待协调。
使用现有项目工具；不自行引入框架依赖或启动后台服务。
