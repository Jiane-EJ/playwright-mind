# playwright-mind

> 基于 `Playwright` 和 `Midscene.js` 的 AI 自动化测试项目。

## 技术栈

* [Playwright](https://github.com/microsoft/playwright) Web UI 自动化测试工具
* [Midscene.js](https://github.com/web-infra-dev/midscene) AI 定位、提取、断言能力

## 安装与配置

1. 克隆项目

```shell
git clone https://github.com/autotestclass/playwright-mind
```

2. 安装依赖

```shell
cd playwright-mind
npm install
```

3. 安装浏览器

```shell
npx playwright install
```

4. 配置 `.env`

> 默认模型可按实际需要替换，其他模型接入方式参考 Midscene 官方文档。

阿里云百练：https://bailian.console.aliyun.com/

模型接入文档：https://midscenejs.com/zh/model-provider.html

```dotenv
OPENAI_API_KEY=sk-your-key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MIDSCENE_MODEL_NAME=qwen3-vl-plus
RUNTIME_DIR_PREFIX=t_runtime/
PLAYWRIGHT_OUTPUT_DIR=t_runtime/test-results
PLAYWRIGHT_HTML_REPORT_DIR=t_runtime/playwright-report
MIDSCENE_RUN_DIR=t_runtime/midscene_run
ACCEPTANCE_RESULT_DIR=t_runtime/acceptance-results
STAGE1_RESULT_DIR=t_runtime/stage1-results
DB_DRIVER=sqlite
DB_FILE_PATH=t_runtime/db/hi_test.sqlite
STAGE1_REQUEST_FILE=specs/stage1/stage1-request.community-create.example.json
STAGE1_BRIEF_FILE=specs/stage1/stage1-brief.txt
STAGE1_CAPTCHA_MODE=auto
STAGE1_CAPTCHA_WAIT_TIMEOUT_MS=120000
STAGE1_EXPLORATION_MODE=deep
STAGE1_INTERACTION_TARGETS=按钮,超链接,输入框,文本域,日期框,单选框,多选框,下拉框,级联下拉框
STAGE2_TASK_FILE=specs/tasks/acceptance-task.community-create.example.json
STAGE2_REQUIRE_APPROVAL=false
STAGE2_CAPTCHA_MODE=auto
STAGE2_CAPTCHA_WAIT_TIMEOUT_MS=120000
```

验证码模式说明（`STAGE1_CAPTCHA_MODE` / `STAGE2_CAPTCHA_MODE`）：
* `auto`：**AI 自动处理滑块**（默认）。使用 Midscene AI 分析截图获取滑块位置，Playwright 模拟真人拖动轨迹
* `manual`：检测到滑块/安全验证后，等待人工完成，再继续执行
* `fail`：检测到滑块/安全验证立即失败
* `ignore`：忽略滑块检测（不建议）

`STAGE1_CAPTCHA_WAIT_TIMEOUT_MS` / `STAGE2_CAPTCHA_WAIT_TIMEOUT_MS`：`manual` 模式下人工处理等待时长（毫秒）。

第一段探索模式说明（`STAGE1_EXPLORATION_MODE`）：
* `deep`：深度探索控件（默认），会尝试覆盖按钮、超链接、输入框、文本域、日期、单选、多选、下拉、级联等交互元素
* `basic`：基础探索，仅执行最小导航和摘要采集

`STAGE1_INTERACTION_TARGETS`：深度探索目标控件，逗号分隔。

### 滑块验证码自动处理

当 `STAGE2_CAPTCHA_MODE=auto` 时，系统会自动处理登录页的滑块验证码：

1. **AI 识别**：使用 Midscene `aiQuery` 分析页面截图，识别滑块按钮位置和滑槽宽度
2. **模拟拖动**：使用 Playwright `mouse` API 模拟真人拖动
   - 15步渐进拖动，easeOut 缓动（先快后慢）
   - 添加随机抖动（-3~3像素）模拟人手轨迹
3. **结果验证**：检查滑块是否消失，最多重试 3 次

自动处理失败时会抛出明确错误，可切换为 `manual` 模式人工处理。

## 运行产物目录

所有运行过程中自动生成的目录统一由 `.env` 管理，默认收敛到 `t_runtime/` 下：

* `PLAYWRIGHT_OUTPUT_DIR`：Playwright 执行产物目录
* `PLAYWRIGHT_HTML_REPORT_DIR`：Playwright HTML 报告目录
* `MIDSCENE_RUN_DIR`：Midscene 运行日志、缓存、报告根目录
* `STAGE1_RESULT_DIR`：第一段探索建模结果目录（`stage1-result.json`、`structured-snapshot.json`、`mapping-report.json`、草稿任务、复核说明）
* `ACCEPTANCE_RESULT_DIR`：第二段结构化结果目录（`result.json`、步骤截图）
* `DB_FILE_PATH`：本地数据库文件目录（默认 `t_runtime/db/hi_test.sqlite`）

默认生成结果如下：

* `t_runtime/test-results/`
* `t_runtime/playwright-report/`
* `t_runtime/midscene_run/report`
* `t_runtime/midscene_run/dump`
* `t_runtime/midscene_run/tmp`
* `t_runtime/midscene_run/cache`
* `t_runtime/stage1-results/`
* `t_runtime/acceptance-results/`
* `t_runtime/db/hi_test.sqlite`

## 全局数据持久化底座

项目已新增全局数据持久化底座，当前默认使用本地 `SQLite` 单文件数据库，表结构按 `MySQL` 兼容子集设计，后续可迁移到 MySQL。

当前基础表包括：

* `ai_task`：任务主记录
* `ai_task_version`：任务版本与 JSON 内容
* `ai_run`：阶段运行主记录
* `ai_run_step`：步骤明细
* `ai_snapshot`：结构化快照（JSON 字符串）
* `ai_artifact`：附件元数据（截图、报告、结果文件路径）
* `ai_audit_log`：关键审计日志

说明：

* 当前文件系统仍保留截图、报告、`result.json` 等原始产物
* 数据库只存结构化信息和文件路径，不直接保存大文件二进制
* 当前实现脚本基于 Node `node:sqlite`，运行时需加 `--experimental-sqlite`
* 当前仅落地本地 `sqlite` 驱动，MySQL 连接能力将在后续阶段补充
* 第二段执行器已接入运行主记录、步骤、快照和核心附件写库
* 任务版本入库时会对 `account.password` 做掩码处理，原始任务文件仍以文件路径形式保留

初始化数据库：

```shell
npm run db:init
```

执行 migration：

```shell
npm run db:migrate
```

## 测试入口

当前测试目录包含第一段和第二段执行入口：

* `tests/generated/stage1-discovery-runner.spec.ts`：第一段探索建模入口（请求 JSON -> 草稿任务）
* `tests/generated/stage2-acceptance-runner.spec.ts`：第二段 JSON 任务执行入口
* `tests/fixture/fixture.ts`：Midscene + Playwright 公共夹具

关键方法说明：

* `.ai`：描述步骤并执行交互
* `.aiQuery`：从页面中提取结构化数据
* `.aiAssert`：执行 AI 断言
* `.aiWaitFor`：AI 等待条件满足（仅在 Playwright 常规等待不适用时使用）

推荐实践：

* 断言优先使用 **Playwright 硬检测**（`getByRole/getByLabel/getByTestId` + 自动重试断言）
* 语义复杂场景优先使用 **`aiQuery + 代码断言`**，减少 `aiAssert` 幻觉风险
* `table-cell-equals` / `table-cell-contains` 会优先尝试 **Playwright 表格列值提取与代码比对**，失败后再降级到 AI 结构化断言
* 最终验收建议以 `table-row-exists` 作为硬门槛；`table-cell-equals` / `table-cell-contains` 只校验少量关键列，且建议配置 `soft=true`
* AI 操作作为兜底，不建议所有步骤都直接依赖自由文本 AI 操作

## 运行测试

```shell
npx playwright test --headed tests/generated/stage2-acceptance-runner.spec.ts
```

执行完成后，可查看：

* Playwright HTML 报告目录：`t_runtime/playwright-report/`
* Midscene 报告目录：`t_runtime/midscene_run/report/`

## 运行第一段（探索建模草稿）

默认读取 `STAGE1_REQUEST_FILE` 指向的请求文件并执行。

如果你不想手写 `stage1-request.json`，推荐固定编辑 `STAGE1_BRIEF_FILE` 指向的文件（默认 `specs/stage1/stage1-brief.txt`），然后执行：

```shell
npm run stage1:generate-request -- --force
```

如需临时指定输入文件，也支持：

```shell
npm run stage1:generate-request -- --file specs/stage1/your-brief.txt --output specs/stage1/stage1-request.generated.json --force
```

生成后，将 `.env` 中 `STAGE1_REQUEST_FILE` 指向生成文件，再执行第一段：

```shell
npm run stage1:run:headed
```

第一段登录验证码处理由 `STAGE1_CAPTCHA_MODE` 控制（默认 `auto`）。
验证码处理后会校验是否已离开登录态；若验证码弹窗关闭但仍停留登录页，会自动重试一次登录并再次处理验证码，仍失败才终止，避免假成功。
第一段会按 `scope.menuPathHints` 尝试导航到目标菜单，并尝试打开“新增/添加”入口做探索；但不会提交新增数据。
第一段默认启用深度探索模式（`deep`），会尝试在无副作用前提下覆盖常见交互控件；如不需要可切换为 `basic`。

执行后将生成：

* 第一段结果：`t_runtime/stage1-results/<requestId>/<timestamp>/stage1-result.json`
* 第一段过程快照：`t_runtime/stage1-results/<requestId>/<timestamp>/stage1-result.partial.json`
* 第一段探索证据：`t_runtime/stage1-results/<requestId>/<timestamp>/evidence/`
* 第一段结构化快照：`t_runtime/stage1-results/<requestId>/<timestamp>/evidence/structured-snapshot.json`
* 第一段字段映射报告：`t_runtime/stage1-results/<requestId>/<timestamp>/evidence/mapping-report.json`
* 第二段草稿任务：`t_runtime/stage1-results/<requestId>/<timestamp>/draft.acceptance-task.json`
* 人工复核说明：`t_runtime/stage1-results/<requestId>/<timestamp>/review-notes.md`

## 第一段通用化规则

* 第一段草稿生成是通用能力，禁止按“新增小区”等单一场景写死字段和断言
* 第一段会对字段标签做标准化与去重，优先输出更规范的第二段草稿结构
* 第一段会优先用结构化样例（如表格行）推断可执行字段值（如省市区、地址、联系方式），无法确认时再保守标注待确认
* 第二段执行前，必须先人工复核 `mapping-report.json` 与 `review-notes.md`

## 第一段到第二段交接（Day7 最小联调）

第一段输出草稿后，推荐按以下最小流程交接到第二段：

1. 运行第一段生成草稿任务：

```shell
npm run stage1:run:headed
```

2. 将最新草稿提升为第二段任务文件（默认写入 `specs/tasks/acceptance-task.generated.json`）：

```shell
npm run stage1:promote
```

可选参数：

* 指定请求：`npm run stage1:promote -- --requestId your_request_id`
* 指定运行目录：`npm run stage1:promote -- --runDir t_runtime/stage1-results/<requestId>/<timestamp>`
* 指定目标文件：`npm run stage1:promote -- --target specs/tasks/your-task.json --force`
* 命令输出会打印 `target.taskFileRelative` 与 `建议：STAGE2_TASK_FILE=...`，直接复制到 `.env` 即可

3. 将 `.env` 中 `STAGE2_TASK_FILE` 指向目标任务文件后执行第二段：

```shell
npm run stage2:run:headed
```

## 运行第二段（任务 JSON 执行）

默认读取 `STAGE2_TASK_FILE` 指向的 JSON 任务文件并执行。

```shell
npm run stage2:run:headed
```

执行后将生成：

* Playwright 报告：`t_runtime/playwright-report/`
* Midscene 报告：`t_runtime/midscene_run/report/`
* 第二段结果：`t_runtime/acceptance-results/<taskId>/<timestamp>/result.json`
* 第二段过程快照：`t_runtime/acceptance-results/<taskId>/<timestamp>/result.partial.json`
* 第二段步骤截图：`t_runtime/acceptance-results/<taskId>/<timestamp>/screenshots/`

同时会写入本地数据库：

* `ai_task`
* `ai_task_version`
* `ai_run`
* `ai_run_step`
* `ai_snapshot`
* `ai_artifact`
* `ai_audit_log`

## 跨平台通用配置（Stage2）

为支持多个 Web 平台接入，任务 JSON 支持以下通用化字段：

* `uiProfile.tableRowSelectors`：平台表格行选择器优先级列表
* `uiProfile.toastSelectors`：平台消息提示选择器优先级列表
* `uiProfile.dialogSelectors`：平台弹窗选择器优先级列表
* `assertions[].matchMode`：行匹配模式（`exact` / `contains`）
* `cleanup.rowMatchMode`：清理时行匹配模式（建议 `exact`）
* `cleanup.verifyAfterCleanup`：删除后是否强制校验目标行消失（建议 `true`）
* `form.fields[].componentType=cascader` 且值为占位文案（如“待确认一级”）时：第二段会自动选择当前层首个可用选项，避免因占位值导致执行中断
* 第二段异常归档增强：即使发生步骤外异常，也会补充 `系统异常_未归档步骤`，避免报告仅显示 `no step detail`

## 当前状态

| 模块 | 状态 | 说明 |
|------|------|------|
| 运行目录规范统一 | 已完成 | 已接入 `.env` 和 `config/runtime-path.ts` |
| Midscene + Playwright 基础样例 | 已完成 | 可运行示例脚本 |
| AI 自主代理验收系统改造方案 | 已完成文档 | 见 `.tasks/AI自主代理验收系统开发改造方案_2026-03-11.md` |
| 第一段完整开发计划 | 已完成文档 | 见 `.plans/第一段探索建模最小改动开发方案_2026-03-13.md` 与 `.tasks/第一段探索建模每日开发计划_2026-03-13.md` |
| 第一段最小入口骨架 | 已完成基础代码 | 已新增 `src/stage1` 最小执行器与 `tests/generated/stage1-discovery-runner.spec.ts` |
| 第一段结构化探索摘要 | 已完成增强 | 已支持 DOM 结构化提取、表格样例行与控件候选摘要输出 |
| 第一段字段映射策略 | 已完成增强 | 已支持字段标准化去重、映射优先级优化和基础值推断 |
| 第一段数据持久化（Day6） | 已完成代码接入 | 已接入第一段运行、步骤、快照、附件路径写库 |
| 第一段自然语言请求转 JSON | 已完成基础代码 | 已支持固定 brief 文件（默认 `specs/stage1/stage1-brief.txt`）及文本/HTML 生成 `stage1-request.generated.json` |
| 第一段登录验证码处理 | 已完成代码接入 | 已支持 `STAGE1_CAPTCHA_MODE` 自动/人工/失败/忽略策略 |
| 第一段到第二段交接联调（Day7） | 进行中 | 已新增草稿提升脚本，待命令级联调验证 |
| 任务输入 JSON 模板 | 已完成模板 | 见 `specs/tasks/` |
| 第二段最小执行器（JSON 驱动） | 已完成 | 入口 `tests/generated/stage2-acceptance-runner.spec.ts` |
| 第二段数据持久化 | 已完成代码接入 | 已接入运行、步骤、快照、附件路径写库 |
| 目录结构整理（运行产物收敛） | 已完成 | 运行目录统一归档到 `t_runtime/` |
| 登录滑块验证码自动处理 | 已完成 | AI + Playwright 自动识别并拖动滑块 |
| 全局数据持久化底座 | 已完成基础创建 | 已新增数据库配置、migration 与初始化脚本 |

## 当前推进顺序

当前按以下顺序推进：

1. 全局数据持久化底座
2. 第二段数据持久化改造
3. 第一段整体方案设计与开发

第一段的最小改动开发方案与按天排期已补充到：

* `.plans/第一段探索建模最小改动开发方案_2026-03-13.md`
* `.tasks/第一段探索建模每日开发计划_2026-03-13.md`
