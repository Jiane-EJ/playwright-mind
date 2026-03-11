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
RUNTIME_DIR_PREFIX=t_
PLAYWRIGHT_OUTPUT_DIR=t_test-results
PLAYWRIGHT_HTML_REPORT_DIR=t_playwright-report
MIDSCENE_RUN_DIR=t_midscene_run
```

## 运行产物目录

所有运行过程中自动生成的目录统一由 `.env` 管理，默认全部以 `t_` 开头：

* `PLAYWRIGHT_OUTPUT_DIR`：Playwright 执行产物目录
* `PLAYWRIGHT_HTML_REPORT_DIR`：Playwright HTML 报告目录
* `MIDSCENE_RUN_DIR`：Midscene 运行日志、缓存、报告根目录

默认生成结果如下：

* `t_test-results/`
* `t_playwright-report/`
* `t_midscene_run/report`
* `t_midscene_run/dump`
* `t_midscene_run/tmp`
* `t_midscene_run/cache`

## 使用示例

`tests` 目录中包含 `bing-search-ai-example.spec.ts` 示例。

```ts
import { expect } from '@playwright/test';
import { test } from './fixture/fixture';

test.beforeEach(async ({ page }) => {
  await page.goto('https://cn.bing.com');
});

test('search keyword on bing', async ({ page, ai, aiQuery, aiAssert }) => {
  await ai('搜索输入框输入"playwright"关键字，并回车');
  await page.waitForTimeout(3000);

  const items = await aiQuery(
    'string[], 搜索结果列表中包含"playwright"相关的标题'
  );

  console.log('search result', items);
  console.log('search result number', items?.length);

  expect(items?.length).toBeGreaterThan(1);
  await aiAssert('检查搜索结果列表第一条标题是否包含"playwright"字符串');
});
```

关键方法说明：

* `.ai`：描述步骤并执行交互
* `.aiQuery`：从页面中提取结构化数据
* `.aiAssert`：执行 AI 断言

## 运行测试

```shell
npx playwright test --headed tests/bing-search-ai-example.spec.ts
```

执行完成后，可查看：

* Playwright HTML 报告目录：`t_playwright-report/`
* Midscene 报告目录：`t_midscene_run/report/`

## 测试报告

![](./images/midscene-report.png)
