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
STAGE2_TASK_FILE=specs/tasks/acceptance-task.community-create.example.json
STAGE2_REQUIRE_APPROVAL=false
```

## 运行产物目录

所有运行过程中自动生成的目录统一由 `.env` 管理，默认收敛到 `t_runtime/` 下：

* `PLAYWRIGHT_OUTPUT_DIR`：Playwright 执行产物目录
* `PLAYWRIGHT_HTML_REPORT_DIR`：Playwright HTML 报告目录
* `MIDSCENE_RUN_DIR`：Midscene 运行日志、缓存、报告根目录
* `ACCEPTANCE_RESULT_DIR`：第二段结构化结果目录（`result.json`、步骤截图）

默认生成结果如下：

* `t_runtime/test-results/`
* `t_runtime/playwright-report/`
* `t_runtime/midscene_run/report`
* `t_runtime/midscene_run/dump`
* `t_runtime/midscene_run/tmp`
* `t_runtime/midscene_run/cache`
* `t_runtime/acceptance-results/`

## 测试入口

当前测试目录仅保留第二段执行器相关文件：

* `tests/generated/stage2-acceptance-runner.spec.ts`：第二段 JSON 任务执行入口
* `tests/fixture/fixture.ts`：Midscene + Playwright 公共夹具

关键方法说明：

* `.ai`：描述步骤并执行交互
* `.aiQuery`：从页面中提取结构化数据
* `.aiAssert`：执行 AI 断言

## 运行测试

```shell
npx playwright test --headed tests/generated/stage2-acceptance-runner.spec.ts
```

执行完成后，可查看：

* Playwright HTML 报告目录：`t_runtime/playwright-report/`
* Midscene 报告目录：`t_runtime/midscene_run/report/`

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

## 当前状态

| 模块 | 状态 | 说明 |
|------|------|------|
| 运行目录规范统一 | 已完成 | 已接入 `.env` 和 `config/runtime-path.ts` |
| Midscene + Playwright 基础样例 | 已完成 | 可运行示例脚本 |
| AI 自主代理验收系统改造方案 | 已完成文档 | 见 `.tasks/AI自主代理验收系统开发改造方案_2026-03-11.md` |
| 任务输入 JSON 模板 | 已完成模板 | 见 `specs/tasks/` |
| 第二段最小执行器（JSON 驱动） | 已完成 | 入口 `tests/generated/stage2-acceptance-runner.spec.ts` |
| 目录结构整理（运行产物收敛） | 已完成 | 运行目录统一归档到 `t_runtime/` |
