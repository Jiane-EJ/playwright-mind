# AI 通用 AI 调用 API

<cite>
**本文引用的文件**
- [README.md](file://README.md)
- [AGENTS.md](file://AGENTS.md)
- [package.json](file://package.json)
- [playwright.config.ts](file://playwright.config.ts)
- [config/runtime-path.ts](file://config/runtime-path.ts)
- [config/db.ts](file://config/db.ts)
- [tests/fixture/fixture.ts](file://tests/fixture/fixture.ts)
- [tests/generated/stage2-acceptance-runner.spec.ts](file://tests/generated/stage2-acceptance-runner.spec.ts)
- [src/stage2/types.ts](file://src/stage2/types.ts)
- [src/stage2/task-runner.ts](file://src/stage2/task-runner.ts)
- [specs/tasks/acceptance-task.community-create.example.json](file://specs/tasks/acceptance-task.community-create.example.json)
- [specs/tasks/acceptance-task.template.json](file://specs/tasks/acceptance-task.template.json)
</cite>

## 目录
1. [简介](#简介)
2. [项目结构](#项目结构)
3. [核心组件](#核心组件)
4. [架构总览](#架构总览)
5. [详细组件分析](#详细组件分析)
6. [依赖关系分析](#依赖关系分析)
7. [性能考量](#性能考量)
8. [故障排查指南](#故障排查指南)
9. [结论](#结论)
10. [附录](#附录)

## 简介
本文件面向希望在测试自动化中使用 AI 的开发者，系统性介绍基于 Midscene.js 与 Playwright 的通用 AI 调用 API 能力。该能力覆盖自然语言指令、上下文理解与执行反馈，支持复杂的页面操作指导、智能决策与动态行为控制。文档重点说明：
- 如何通过 ai、aiQuery、aiAssert、aiWaitFor 等接口进行交互与断言
- 在测试中如何使用 AI 完成级联选择器、按钮点击、表单填写等高级场景
- 性能与成本控制策略、最佳实践与常见问题排查

## 项目结构
该项目采用“配置驱动 + JSON 任务 + Midscene + Playwright”的分层架构：
- 配置层：运行目录、数据库、环境变量集中管理
- 测试层：统一夹具注入 AI 能力，提供 ai、aiQuery、aiAssert、aiWaitFor
- 执行层：基于 JSON 任务驱动的第二段执行器，内置断言与清理策略
- 产物层：Playwright 报告、Midscene 报告、结构化结果与数据库落盘

```mermaid
graph TB
subgraph "配置层"
ENV[".env<br/>运行目录/数据库/模型配置"]
RUNPATH["config/runtime-path.ts<br/>运行目录解析"]
DBCFG["config/db.ts<br/>数据库配置"]
end
subgraph "测试层"
FIX["tests/fixture/fixture.ts<br/>统一夹具注入 ai/aiQuery/aiAssert/aiWaitFor"]
CFG["playwright.config.ts<br/>报告与项目配置"]
end
subgraph "执行层"
SPEC["tests/generated/stage2-acceptance-runner.spec.ts<br/>测试入口"]
TR["src/stage2/task-runner.ts<br/>第二段执行器"]
TYPES["src/stage2/types.ts<br/>任务与断言模型"]
end
subgraph "任务与产物"
TASK_EXAMPLE["specs/tasks/acceptance-task.community-create.example.json<br/>示例任务"]
TASK_TEMPLATE["specs/tasks/acceptance-task.template.json<br/>模板任务"]
end
ENV --> RUNPATH
ENV --> DBCFG
RUNPATH --> FIX
DBCFG --> TR
FIX --> SPEC
SPEC --> TR
TYPES --> TR
TASK_EXAMPLE --> SPEC
TASK_TEMPLATE --> SPEC
CFG --> SPEC
```

**图表来源**
- [config/runtime-path.ts:1-46](file://config/runtime-path.ts#L1-L46)
- [config/db.ts:1-28](file://config/db.ts#L1-L28)
- [tests/fixture/fixture.ts:1-100](file://tests/fixture/fixture.ts#L1-L100)
- [playwright.config.ts:1-95](file://playwright.config.ts#L1-L95)
- [tests/generated/stage2-acceptance-runner.spec.ts:1-39](file://tests/generated/stage2-acceptance-runner.spec.ts#L1-L39)
- [src/stage2/task-runner.ts:1-200](file://src/stage2/task-runner.ts#L1-L200)
- [src/stage2/types.ts:1-180](file://src/stage2/types.ts#L1-L180)
- [specs/tasks/acceptance-task.community-create.example.json:1-229](file://specs/tasks/acceptance-task.community-create.example.json#L1-L229)
- [specs/tasks/acceptance-task.template.json:1-141](file://specs/tasks/acceptance-task.template.json#L1-L141)

**章节来源**
- [README.md:10-253](file://README.md#L10-L253)
- [package.json:1-28](file://package.json#L1-L28)
- [playwright.config.ts:1-95](file://playwright.config.ts#L1-L95)
- [config/runtime-path.ts:1-46](file://config/runtime-path.ts#L1-L46)
- [config/db.ts:1-28](file://config/db.ts#L1-L28)
- [tests/fixture/fixture.ts:1-100](file://tests/fixture/fixture.ts#L1-L100)
- [tests/generated/stage2-acceptance-runner.spec.ts:1-39](file://tests/generated/stage2-acceptance-runner.spec.ts#L1-L39)
- [src/stage2/types.ts:1-180](file://src/stage2/types.ts#L1-L180)
- [src/stage2/task-runner.ts:1-200](file://src/stage2/task-runner.ts#L1-L200)
- [specs/tasks/acceptance-task.community-create.example.json:1-229](file://specs/tasks/acceptance-task.community-create.example.json#L1-L229)
- [specs/tasks/acceptance-task.template.json:1-141](file://specs/tasks/acceptance-task.template.json#L1-L141)

## 核心组件
- 夹具注入的 AI 能力
  - ai：执行自然语言动作（如点击、填写、滚动、等待），支持 action/query 两种类型
  - aiQuery：从页面提取结构化数据，返回 JSON 结构
  - aiAssert：执行 AI 断言，返回布尔与原因
  - aiWaitFor：在 Playwright 常规等待不适用时，使用 AI 等待条件满足
- 第二段执行器
  - 基于 JSON 任务驱动，内置导航、打开弹窗、填写表单、提交、搜索、断言、清理等步骤
  - 断言策略：Playwright 硬检测优先，AI 断言兜底，带重试与软断言支持
- 任务模型与 UI 配置
  - AcceptanceTask、TaskAssertion、TaskCleanup 等模型定义
  - uiProfile 支持跨平台选择器优先级（表格行、Toast、弹窗）

**章节来源**
- [tests/fixture/fixture.ts:16-99](file://tests/fixture/fixture.ts#L16-L99)
- [src/stage2/task-runner.ts:1529-1556](file://src/stage2/task-runner.ts#L1529-L1556)
- [src/stage2/task-runner.ts:1562-1917](file://src/stage2/task-runner.ts#L1562-L1917)
- [src/stage2/types.ts:67-126](file://src/stage2/types.ts#L67-L126)

## 架构总览
AI 调用 API 在测试夹具中统一注入，通过 PlaywrightAgent 与 PlaywrightWebPage 封装，结合 Midscene 的 aiQuery/aiAssert/aiWaitFor 能力，形成“自然语言 + 结构化数据 + 智能断言”的闭环。

```mermaid
sequenceDiagram
participant Test as "测试用例"
participant Fix as "夹具(ai/aiQuery/aiAssert/aiWaitFor)"
participant Agent as "PlaywrightAgent"
participant Page as "PlaywrightWebPage"
participant Mid as "Midscene AI引擎"
Test->>Fix : 调用 ai("点击按钮...")/aiQuery(...)/aiAssert(...)/aiWaitFor(...)
Fix->>Agent : 创建 Agent 并传入 Page
Agent->>Page : 绑定页面上下文
Agent->>Mid : 发送自然语言/结构化请求
Mid-->>Agent : 返回结构化结果/断言结果/等待状态
Agent-->>Fix : 包装后的结果
Fix-->>Test : 执行结果/断言通过/等待完成
```

**图表来源**
- [tests/fixture/fixture.ts:23-99](file://tests/fixture/fixture.ts#L23-L99)
- [src/stage2/task-runner.ts:1562-1917](file://src/stage2/task-runner.ts#L1562-L1917)

## 详细组件分析

### 夹具与 AI 能力注入
- 夹具在每个测试用例中注入 ai、aiQuery、aiAssert、aiWaitFor 四个函数，并设置缓存 ID、分组信息与报告生成
- ai 支持通过 opts.type 指定“动作”或“查询”，aiQuery/aiAssert/aiWaitFor 为专用能力封装
- Midscene 运行日志目录通过 setLogDir 统一收敛到运行目录

```mermaid
classDiagram
class PlaywrightAgent {
+ai(prompt, type) Promise<any>
+aiAction(taskPrompt) Promise<void>
+aiQuery(demand) Promise<any>
+aiAssert(assertion, errorMsg) Promise<void>
+aiWaitFor(condition, opt) Promise<void>
}
class PlaywrightWebPage {
+page Page
}
class Fixture {
+ai(prompt, opts) Promise<any>
+aiQuery(demand) Promise<any>
+aiAssert(assertion, errorMsg?) Promise<void>
+aiWaitFor(condition, opt?) Promise<void>
}
PlaywrightAgent --> PlaywrightWebPage : "封装"
Fixture --> PlaywrightAgent : "创建并暴露"
```

**图表来源**
- [tests/fixture/fixture.ts:23-99](file://tests/fixture/fixture.ts#L23-L99)

**章节来源**
- [tests/fixture/fixture.ts:1-100](file://tests/fixture/fixture.ts#L1-L100)

### 第二段执行器与断言策略
- 执行器内置多种步骤：导航、打开弹窗、填写表单、提交、搜索、断言、清理
- 断言策略优先使用 Playwright 硬检测，失败时降级到 aiQuery/aiAssert，并支持重试与软断言
- 通用断言入口会根据断言类型选择 Playwright 或 AI 能力，未知类型则使用 aiQuery 通用断言兜底

```mermaid
flowchart TD
Start(["开始断言"]) --> TypeCheck{"断言类型？"}
TypeCheck --> |toast/table-row-exists| PW["Playwright 硬检测"]
TypeCheck --> |table-cell-equals/contains| PWTable["表格列提取 + 代码断言"]
TypeCheck --> |custom| AICustom["aiQuery 结构化断言"]
TypeCheck --> |未知| AIGeneral["aiQuery 通用断言"]
PW --> Retry{"是否通过？"}
PWTable --> Retry
AICustom --> Retry
AIGeneral --> Retry
Retry --> |是| Pass["断言通过"]
Retry --> |否| Retries{"重试次数未用完？"}
Retries --> |是| AICustom
Retries --> |否| Fail["断言失败"]
```

**图表来源**
- [src/stage2/task-runner.ts:1562-1917](file://src/stage2/task-runner.ts#L1562-L1917)

**章节来源**
- [src/stage2/task-runner.ts:1529-1556](file://src/stage2/task-runner.ts#L1529-L1556)
- [src/stage2/task-runner.ts:1562-1917](file://src/stage2/task-runner.ts#L1562-L1917)

### 级联选择器、按钮点击与表单填写的高级场景
- 级联选择器
  - 通过 openCascaderPanel 打开面板，逐级点击选项，使用 tryClickLocator 与 getByText 精确命中
  - 若页面元素不稳定，最终回退到 ai("在省市区级联面板中点击...") 完成选择
- 按钮点击
  - 优先使用 getByRole('button', { name: /正则/ }) 精确匹配，其次使用 loose 匹配
  - 若均失败，回退到 ai("点击按钮...") 完成操作
- 表单填写
  - 优先在弹窗上下文中定位字段，使用 input/textarea 的 role 与占位文案
  - 若仍失败，回退到 ai("在弹窗中，在字段...输入...") 完成填写

```mermaid
sequenceDiagram
participant TR as "执行器"
participant Page as "页面"
participant AI as "AI 能力"
TR->>Page : 打开级联面板
loop 逐级选择
TR->>Page : 点击选项(精确/模糊)
alt 命中
Page-->>TR : 成功
else 未命中
TR->>AI : ai("点击选项...")
AI-->>TR : 执行结果
end
end
TR->>Page : 校验级联值
alt 未成功
TR->>AI : ai("在弹窗中填写字段...")
AI-->>TR : 执行结果
end
```

**图表来源**
- [src/stage2/task-runner.ts:726-788](file://src/stage2/task-runner.ts#L726-L788)
- [src/stage2/task-runner.ts:897-974](file://src/stage2/task-runner.ts#L897-L974)

**章节来源**
- [src/stage2/task-runner.ts:726-788](file://src/stage2/task-runner.ts#L726-L788)
- [src/stage2/task-runner.ts:897-974](file://src/stage2/task-runner.ts#L897-L974)

### 任务模型与 UI 配置
- AcceptanceTask：任务主入口，包含目标站点、账户、导航、UI 配置、表单、搜索、断言、清理、运行时配置
- TaskAssertion：断言类型丰富，支持 toast、table-row-exists、table-cell-equals/contains、custom 等
- TaskCleanup：支持删除新增数据、删除全部匹配、自定义 AI 指令，以及行匹配模式与清理后校验

```mermaid
erDiagram
ACCEPTANCE_TASK {
string taskId
string taskName
object target
object account
object navigation
object uiProfile
object form
object search
array assertions
object cleanup
object runtime
object approval
}
TASK_ASSERTION {
string type
string expectedText
string matchField
array expectedColumns
object expectedColumnFromFields
object expectedColumnValues
string column
string expectedFromField
string matchMode
number timeoutMs
number retryCount
boolean soft
string description
}
TASK_CLEANUP {
boolean enabled
string strategy
string matchField
object action
boolean searchBeforeCleanup
string rowMatchMode
boolean verifyAfterCleanup
boolean failOnError
string notes
}
ACCEPTANCE_TASK ||--o{ TASK_ASSERTION : "包含"
ACCEPTANCE_TASK ||--o{ TASK_CLEANUP : "包含"
```

**图表来源**
- [src/stage2/types.ts:141-180](file://src/stage2/types.ts#L141-L180)
- [src/stage2/types.ts:67-126](file://src/stage2/types.ts#L67-L126)

**章节来源**
- [src/stage2/types.ts:1-180](file://src/stage2/types.ts#L1-L180)

### 示例任务与使用指引
- 示例任务展示了完整的新增小区流程：登录 → 导航 → 打开弹窗 → 填写表单（含级联） → 提交 → 搜索校验 → 清理
- 模板任务提供了可复制的字段与断言结构，便于快速扩展

**章节来源**
- [specs/tasks/acceptance-task.community-create.example.json:1-229](file://specs/tasks/acceptance-task.community-create.example.json#L1-L229)
- [specs/tasks/acceptance-task.template.json:1-141](file://specs/tasks/acceptance-task.template.json#L1-L141)

## 依赖关系分析
- 运行时目录与数据库路径由 .env 与 config/runtime-path.ts、config/db.ts 统一解析
- 测试入口 tests/generated/stage2-acceptance-runner.spec.ts 通过夹具注入 AI 能力，并调用第二段执行器
- 执行器内部根据任务模型选择 Playwright 或 AI 能力，断言与清理策略贯穿始终

```mermaid
graph LR
ENV[".env"] --> RUNPATH["config/runtime-path.ts"]
ENV --> DBCFG["config/db.ts"]
RUNPATH --> FIX["tests/fixture/fixture.ts"]
DBCFG --> TR["src/stage2/task-runner.ts"]
FIX --> SPEC["tests/generated/stage2-acceptance-runner.spec.ts"]
SPEC --> TR
TYPES["src/stage2/types.ts"] --> TR
TASK_EXAMPLE["specs/tasks/acceptance-task.community-create.example.json"] --> SPEC
TASK_TEMPLATE["specs/tasks/acceptance-task.template.json"] --> SPEC
```

**图表来源**
- [config/runtime-path.ts:1-46](file://config/runtime-path.ts#L1-L46)
- [config/db.ts:1-28](file://config/db.ts#L1-L28)
- [tests/fixture/fixture.ts:1-100](file://tests/fixture/fixture.ts#L1-L100)
- [tests/generated/stage2-acceptance-runner.spec.ts:1-39](file://tests/generated/stage2-acceptance-runner.spec.ts#L1-L39)
- [src/stage2/task-runner.ts:1-200](file://src/stage2/task-runner.ts#L1-L200)
- [src/stage2/types.ts:1-180](file://src/stage2/types.ts#L1-L180)
- [specs/tasks/acceptance-task.community-create.example.json:1-229](file://specs/tasks/acceptance-task.community-create.example.json#L1-L229)
- [specs/tasks/acceptance-task.template.json:1-141](file://specs/tasks/acceptance-task.template.json#L1-L141)

**章节来源**
- [README.md:10-253](file://README.md#L10-L253)
- [package.json:1-28](file://package.json#L1-L28)
- [playwright.config.ts:1-95](file://playwright.config.ts#L1-L95)
- [config/runtime-path.ts:1-46](file://config/runtime-path.ts#L1-L46)
- [config/db.ts:1-28](file://config/db.ts#L1-L28)
- [tests/fixture/fixture.ts:1-100](file://tests/fixture/fixture.ts#L1-L100)
- [tests/generated/stage2-acceptance-runner.spec.ts:1-39](file://tests/generated/stage2-acceptance-runner.spec.ts#L1-L39)
- [src/stage2/task-runner.ts:1-200](file://src/stage2/task-runner.ts#L1-L200)
- [src/stage2/types.ts:1-180](file://src/stage2/types.ts#L1-L180)
- [specs/tasks/acceptance-task.community-create.example.json:1-229](file://specs/tasks/acceptance-task.community-create.example.json#L1-L229)
- [specs/tasks/acceptance-task.template.json:1-141](file://specs/tasks/acceptance-task.template.json#L1-L141)

## 性能考量
- 模型成本控制
  - 将长流程拆分为多个短 Prompt 的步骤，避免一次性超长 Prompt 导致成本上升与定位困难
  - 优先使用 Playwright 硬检测，AI 仅作为兜底与复杂语义场景的补充
- 等待与重试
  - aiWaitFor 仅在常规等待不适用时使用，避免频繁调用 AI 增加延迟
  - 断言与清理支持重试与软断言，减少误报导致的失败风暴
- 截图与报告
  - 合理开启截图与报告，避免过多截图影响性能与存储成本
- 运行目录与数据库
  - 统一运行目录与报告输出，便于资源回收与成本统计

[本节为通用指导，无需列出具体文件来源]

## 故障排查指南
- AI 操作失败
  - 检查任务 hints 与 uiProfile，确保 Midscene 能准确理解页面元素
  - 将复杂步骤拆分为更细粒度的步骤，便于定位失败点
- 断言失败
  - 优先确认 Playwright 硬检测是否可用，AI 断言仅作为兜底
  - 对未知断言类型，确认 aiQuery 返回结构是否符合预期
- 页面元素不稳定
  - 使用 aiWaitFor 等待稳定状态，或在执行器中增加重试与截图
- 运行产物与日志
  - 查看 Midscene 报告与 Playwright HTML 报告，定位失败步骤与截图

**章节来源**
- [README.md:144-158](file://README.md#L144-L158)
- [src/stage2/task-runner.ts:1562-1917](file://src/stage2/task-runner.ts#L1562-L1917)

## 结论
通过夹具统一注入的 AI 能力与第二段执行器的结构化任务驱动，本项目实现了“自然语言 + 结构化数据 + 智能断言”的测试自动化闭环。建议在日常开发中遵循“Playwright 硬检测优先、AI 兜底”的原则，合理拆分步骤、控制重试与截图，以获得更高的稳定性与更低的成本。

[本节为总结性内容，无需列出具体文件来源]

## 附录
- 运行与产物
  - 运行第二段：npx playwright test tests/generated/stage2-acceptance-runner.spec.ts --headed
  - 产物目录：Playwright 报告、Midscene 报告、结构化结果与数据库落盘
- 配置与规范
  - 统一使用 .env 管理路径与开关，避免硬编码
  - 日志与报告统一收敛到 t_runtime/ 下的子目录

**章节来源**
- [README.md:159-212](file://README.md#L159-L212)
- [AGENTS.md:22-61](file://AGENTS.md#L22-L61)