# Router / Worker 模板设计

内置模板 `router-worker`，包含一个 Router（成员 ID 沿用 `leader`）和两个对等的通用 Worker。适用于多个相对独立的需求、缺陷调查和持续返工；单个强耦合任务由一个 Worker 完整处理，不为并行而拆成多个技术阶段。

## 对 DeepSeek Super-agent 的理解

研究对象是 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)，不是第三方同名实现。该仓库自述为研究原型，公开版本与设计文章也不完全相同。

根据其 [领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)，输入事件是 Trigger，交流上下文是 Thread，授权工作的单位是 Ticket，Assignment 将 Ticket 绑定到 Executor。任务身份独立于执行会话，不能把会话结束等同于任务完成。

其 [提示设计](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/004-prompts.md) 和 [路由指令](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/prompts/dispatch.md) 给出了关键分工：

- Router 保留原始请求，只判断新建、归属、停止或忽略，不附加技术方案或自行扩写验收要求。
- Worker 负责技术判断和完整执行；已有任务的后续反馈由原 Worker 判断，范围外请求交回 Router。明确的任务引用才能建立归属，主题相似不足以归并。
- Router 只转交可用结果和具体人工问题，日常进展留在内部，避免用户承担日常协调。

[执行模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md) 为每个 Ticket 建立独立执行会话和目录，支持排队、反馈续接与恢复；[会话实现](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/sessions.ts) 还限制 Router 等待，因为运行时会自动送达结果。这个“不等待”依赖其消息与运行时机制，不能脱离宿主直接照搬。

## 本项目中的落点

| 方面 | 现有 development 模板 | router-worker 模板 |
| --- | --- | --- |
| 分工 | Leader 协调 Developer、Reviewer | Router 路由，两个 Worker 对任务完整负责 |
| 技术判断 | Leader 拆分开发与评审工作 | Worker 自主调查和选择实现 |
| 任务延续 | Leader 按阶段再次分派 | 任务 ID 与负责 Worker 持续绑定 |
| 评审 | 固定 Reviewer | 按风险由另一空闲 Worker 只读复核 |
| 协调记录 | 自然语言交接 | Router 独占维护轻量任务索引 |

### 保留与适配

- 保留原始请求、薄路由、通用执行者、任务归属、范围外交回和低干扰交付。
- 所有成员仍共享当前 worktree。Worker 先只读调查并申报写入范围，Router 确认文件占用；有重叠时串行。全局格式化、生成代码和依赖变更同样计入写入范围。
- Router 保留现有启动器要求的最终验证职责，具体技术调查与修复交给 Worker。共享目录中的 Git 操作继续集中协调，不沿用原型每个 Executor 自行处理分支与 PR 的流程。
- 两个 Worker 是启动时固定的执行槽，不是每个任务自动创建的新会话。一个 Worker 同一时间只负责一个未交接任务；终端空闲不代表槽位已释放。任务切换必须先结清或明确交接旧任务，避免上下文混淆。
- 使用现有后端注入的 get、wait、read 和投递命令；保留 wait 以兼容旧版 Herdr。core 的主动汇报也不能视为可靠事件队列，仍需读取实际输出确认结果。向忙碌 Worker 的补充暂存在任务索引，确认可接收后投递。

### 轻量任务索引

实际接单后由 Router 创建 `.team/tasks.md`，无需新增配置字段或解析逻辑。每个任务记录：

```text
ID: T001
原始请求: <用户原文；长上下文附来源路径>
明确约束: <用户已提出的条件>
负责 Worker: worker-a
状态: working
占用范围: <Worker 申报并经协调的文件或目录>
依赖: <任务 ID；无则为空>
待投递补充: <原文、来源、是否已投递>
验证结论: <实际检查与结果；未验证时明示>
产物: <文件路径或报告位置>
```

状态区分 queued、working、waiting、ready、blocked、failed、dropped、done：ready 是 Worker 可交付，done 是 Router 最终验证通过；waiting 不等于完成。发送失败或超时先核查是否已送达，不能靠重复派工恢复。暂停和停止显式记入任务约束，在用户解除前不恢复。

这些记录和文件占用都由 Agent 遵守，属于提示层约定，不提供事务锁、幂等执行或自动崩溃恢复。重启后 Router 应核对索引、成员输出与实际文件，再决定续接，不盲目重放。

### 示例

用户要求“修复导出乱码，并补充登录限流”。Router 保留这两个原始请求，分别记为 T001、T002，派给 worker-a、worker-b。两个 Worker 先调查并申报写入范围；若都需要修改同一配置文件，Router 安排串行，互不重叠的实现才并行。

用户补充“T001 还要兼容 Excel”，Router 记录原文并交给 worker-a 判断是否在原任务范围内。若 Worker 认为扩大范围，说明原因交回 Router 协调。实现 ready 后，可安排 worker-b 对冻结的 T001 成果只读复核，worker-a 处理问题；最终验证通过后由 Router 交付。

## 可选通信检查

`init . router-worker` 只选择团队职责，默认不触发通信探针。需要验证真实工具权限时，在初始化后的 `.team/team.md` frontmatter 中添加 `workflow: router-worker`，保留其他字段和正文：

```yaml
---
name: router-worker-team
workflow: router-worker
leader: leader
members:
  - members/leader.md
  - members/worker-a.md
  - members/worker-b.md
---
```

随后按通常方式启动团队。检查在角色初始化之后独立执行：

1. Router 调用实际后端查询 Worker，启动器核对结果中的身份。
2. 每个 Worker 查询 Router，并向它发送一次性 challenge。
3. Router 收到匹配消息后写回执，启动器核对后记录 `communication_check: verified`，再保存团队 ready。

检查失败时，启动阶段为 `checking communication`，状态为 partial，保留 `.team/.communication-*` 下的探针和证据。不会自动批准权限、修改沙箱或重发探针。若启动器已经退出，处理权限问题后仍需关闭该测试团队再启动；partial 不会自动续接。

正在运行的团队不会因修改配置而获得新检查，未通过检查的旧 ready 团队也不会直接作为已验证团队复用。启用前先关闭旧团队，避免影响正在执行的任务。此能力检查的是查询与回传路径，不能证明任务调度、写入冲突协调和最终交付全部正确。

## 当前边界与验证

运行时使用 TypeScript，CLI 需要 Node.js 22.13+。团队默认启动 Codex，不依赖 DeepSeek 模型、Harness 或其插件。实际任务的归属、文件范围和状态由 Agent 遵守，尚未实现派工版本校验、自动上下文切换或运行时任务归档。

自动 GitHub/飞书监听、Thread 订阅、每任务独立 worktree、动态 Worker 会话、持久化事件队列及原型的准入策略都需要后续运行时工程，不属于本模板能力。

`test/config.test.mjs` 覆盖模板发现、初始化和成员解析；`test/communication.test.mjs` 使用模拟执行者覆盖通信检查成功与失败。真实 Agent 历史测试仅完成了初始化和复用，开发任务分派曾被通信权限阻塞；尚不能认定路由、范围交接、复核与最终交付已端到端通过。当前结果见[验证记录](verification.md#验证记录)。

```sh
npm ci
npm run build
bin/herdr-team init /absolute/project/path router-worker
bin/herdr-team check /absolute/project/path
bin/herdr-team core start /absolute/project/path
```
