import fs from 'fs';
import path from 'path';
import type { Page } from '@playwright/test';
import type { PlayWrightAiFixtureType } from '@midscene/web/playwright';
import { acceptanceResultDir, resolveRuntimePath } from '../../config/runtime-path';
import { loadTask, resolveTaskFilePath } from './task-loader';
import type {
  AcceptanceTask,
  Stage2ExecutionResult,
  StepResult,
  TaskAssertion,
  TaskField,
} from './types';

type AiContext = Pick<
  PlayWrightAiFixtureType,
  'ai' | 'aiAssert' | 'aiQuery' | 'aiWaitFor'
>;

type RunnerContext = AiContext & {
  page: Page;
};

type RunnerOptions = {
  rawTaskFilePath?: string;
};

function toDisplayValue(value: string | string[]): string {
  if (Array.isArray(value)) {
    return value.join('/');
  }
  return value;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.-]/g, '_');
}

function nowStamp(): string {
  const date = new Date();
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function createRunDir(taskId: string): {
  runDir: string;
  screenshotDir: string;
} {
  const baseResultDir = resolveRuntimePath(acceptanceResultDir);
  const runDir = path.join(baseResultDir, sanitizeFileName(taskId), nowStamp());
  const screenshotDir = path.join(runDir, 'screenshots');
  fs.mkdirSync(screenshotDir, { recursive: true });
  return { runDir, screenshotDir };
}

function withPageTimeout(runtimeTimeoutMs: number | undefined): {
  timeout: number;
} | undefined {
  if (!runtimeTimeoutMs || runtimeTimeoutMs <= 0) {
    return undefined;
  }
  return { timeout: runtimeTimeoutMs };
}

function withWaitForTimeout(runtimeTimeoutMs: number | undefined): {
  timeoutMs: number;
} | undefined {
  if (!runtimeTimeoutMs || runtimeTimeoutMs <= 0) {
    return undefined;
  }
  return { timeoutMs: runtimeTimeoutMs };
}

function resolveFieldValues(task: AcceptanceTask): Record<string, string> {
  const result: Record<string, string> = {};
  task.form.fields.forEach((field) => {
    result[field.label] = toDisplayValue(field.value);
  });
  return result;
}

async function fillField(
  field: TaskField,
  task: AcceptanceTask,
  runner: RunnerContext,
): Promise<void> {
  const hints = (field.hints || []).join('；');
  if (field.componentType === 'cascader' && Array.isArray(field.value)) {
    const cascaderPath = field.value.join(' > ');
    await runner.ai(
      `在弹窗“${task.form.dialogTitle || task.form.openButtonText}”中，点击字段“${field.label}”，并依次选择“${cascaderPath}”。${hints}`,
    );
    return;
  }
  const fieldValue = toDisplayValue(field.value);
  const componentTips =
    field.componentType === 'textarea'
      ? '这是多行文本输入框。'
      : '这是单行输入框。';
  await runner.ai(
    `在弹窗“${task.form.dialogTitle || task.form.openButtonText}”中，在字段“${field.label}”输入“${fieldValue}”。${componentTips}${hints}`,
  );
}

async function runAssertion(
  assertion: TaskAssertion,
  task: AcceptanceTask,
  resolvedValues: Record<string, string>,
  runner: RunnerContext,
): Promise<void> {
  if (assertion.type === 'toast' && assertion.expectedText) {
    await runner.aiWaitFor(`页面出现提示“${assertion.expectedText}”`);
    return;
  }
  if (assertion.type === 'table-row-exists' && assertion.matchField) {
    const expectedValue = resolvedValues[assertion.matchField] || '';
    await runner.aiAssert(`检查列表中存在“${expectedValue}”对应的数据行`);
    return;
  }
  if (assertion.type === 'table-cell-equals' && assertion.matchField) {
    const expectedValue = resolvedValues[assertion.matchField] || '';
    const columns = (assertion.expectedColumns || []).join('、');
    await runner.aiAssert(
      `检查列表中“${assertion.matchField}”为“${expectedValue}”的这一行，列“${columns}”均显示为本次新增数据对应值`,
    );
    return;
  }
  if (
    assertion.type === 'table-cell-contains' &&
    assertion.matchField &&
    assertion.column &&
    assertion.expectedFromField
  ) {
    const matchValue = resolvedValues[assertion.matchField] || '';
    const expectedValue = resolvedValues[assertion.expectedFromField] || '';
    await runner.aiAssert(
      `检查列表中“${assertion.matchField}”为“${matchValue}”的这一行，列“${assertion.column}”包含“${expectedValue}”`,
    );
    return;
  }
  // 保底策略：未知断言类型交给 aiAssert 直接执行文本断言。
  await runner.aiAssert(
    `根据当前页面内容执行断言：${JSON.stringify(assertion)}`,
  );
}

export async function runTaskScenario(
  runner: RunnerContext,
  options?: RunnerOptions,
): Promise<Stage2ExecutionResult> {
  const taskFilePath = resolveTaskFilePath(options?.rawTaskFilePath);
  const task = loadTask(taskFilePath);
  const requireApproval = process.env.STAGE2_REQUIRE_APPROVAL === 'true';
  if (requireApproval && !task.approval?.approved) {
    throw new Error(
      `当前要求人工审批后执行（STAGE2_REQUIRE_APPROVAL=true），任务未审批：${task.taskId}`,
    );
  }

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const stepTimeout = task.runtime?.stepTimeoutMs;
  const { runDir, screenshotDir } = createRunDir(task.taskId);
  const steps: StepResult[] = [];
  const querySnapshots: Record<string, unknown> = {};
  const resolvedValues = resolveFieldValues(task);

  const runStep = async (
    stepName: string,
    handler: () => Promise<void>,
  ): Promise<void> => {
    const stepStartedAt = Date.now();
    const stepResult: StepResult = {
      name: stepName,
      status: 'passed',
      startedAt: new Date(stepStartedAt).toISOString(),
      endedAt: new Date(stepStartedAt).toISOString(),
      durationMs: 0,
    };
    try {
      await handler();
      if (task.runtime?.screenshotOnStep) {
        const shotFileName = `${String(steps.length + 1).padStart(2, '0')}_${sanitizeFileName(stepName)}.png`;
        const shotPath = path.join(screenshotDir, shotFileName);
        await runner.page.screenshot({ path: shotPath, fullPage: true });
        stepResult.screenshotPath = shotPath;
      }
    } catch (error) {
      stepResult.status = 'failed';
      const shotFileName = `${String(steps.length + 1).padStart(2, '0')}_${sanitizeFileName(stepName)}_failed.png`;
      const shotPath = path.join(screenshotDir, shotFileName);
      await runner.page.screenshot({ path: shotPath, fullPage: true });
      stepResult.screenshotPath = shotPath;
      stepResult.message = error instanceof Error ? error.message : String(error);
      stepResult.errorStack = error instanceof Error ? error.stack : undefined;
      const endedOnError = Date.now();
      stepResult.endedAt = new Date(endedOnError).toISOString();
      stepResult.durationMs = endedOnError - stepStartedAt;
      steps.push(stepResult);
      throw error;
    }
    const stepEndedAt = Date.now();
    stepResult.endedAt = new Date(stepEndedAt).toISOString();
    stepResult.durationMs = stepEndedAt - stepStartedAt;
    steps.push(stepResult);
  };

  let finalStatus: 'passed' | 'failed' = 'passed';
  try {
    await runStep('打开系统首页', async () => {
      await runner.page.goto(task.target.url, withPageTimeout(task.runtime?.pageTimeoutMs));
    });

    await runStep('登录系统', async () => {
      const hints = (task.account.loginHints || []).join('；');
      await runner.ai(
        `请在登录页完成登录：账号输入“${task.account.username}”，密码输入“${task.account.password}”，点击登录。${hints}`,
      );
    });

    if (task.navigation?.homeReadyText) {
      await runStep('等待首页加载', async () => {
        await runner.aiWaitFor(
          `页面出现“${task.navigation?.homeReadyText}”`,
          withWaitForTimeout(stepTimeout),
        );
      });
    }

    if (task.navigation?.menuPath?.length) {
      for (let i = 0; i < task.navigation.menuPath.length; i += 1) {
        const menuName = task.navigation.menuPath[i];
        await runStep(`点击菜单_${menuName}`, async () => {
          const menuHints = (task.navigation?.menuHints || []).join('；');
          await runner.ai(`点击左侧菜单“${menuName}”。${menuHints}`);
        });
      }
    }

    await runStep('打开新增小区弹窗', async () => {
      await runner.ai(`点击按钮“${task.form.openButtonText}”`);
    });

    if (task.form.dialogTitle) {
      await runStep('等待新增弹窗显示', async () => {
        await runner.aiWaitFor(
          `页面出现弹窗标题“${task.form.dialogTitle}”`,
          withWaitForTimeout(stepTimeout),
        );
      });
    }

    for (let i = 0; i < task.form.fields.length; i += 1) {
      const field = task.form.fields[i];
      await runStep(`填写字段_${field.label}`, async () => {
        await fillField(field, task, runner);
      });
    }

    await runStep('提交新增表单', async () => {
      await runner.ai(`点击按钮“${task.form.submitButtonText}”`);
    });

    if (task.form.successText) {
      await runStep('检查提交提示', async () => {
        await runner.aiWaitFor(
          `页面出现提示“${task.form.successText}”`,
          withWaitForTimeout(stepTimeout),
        );
      });
    }

    if (task.form.closeButtonText) {
      await runStep('关闭新增弹窗', async () => {
        await runner.ai(`点击按钮“${task.form.closeButtonText}”关闭弹窗`);
      });
    }

    if (task.search) {
      const keywordField = task.search.keywordFromField || '小区名称';
      const keyword = resolvedValues[keywordField] || resolvedValues['小区名称'] || '';
      await runStep('输入搜索条件', async () => {
        await runner.ai(
          `在搜索区字段“${task.search?.inputLabel}”输入“${keyword}”`,
        );
      });
      await runStep('点击查询按钮', async () => {
        await runner.ai(`点击按钮“${task.search?.triggerButtonText || '查询'}”`);
      });
      await runStep('检查列表包含新增数据', async () => {
        await runner.aiAssert(
          `检查列表中存在“${keyword}”这一条小区数据`,
        );
      });
      await runStep('提取列表快照', async () => {
        const result = await runner.aiQuery<string[]>(
          'string[], 提取当前列表前10行的小区名称',
        );
        querySnapshots.tableCommunityNames = result;
      });
    }

    if (task.assertions?.length) {
      for (let i = 0; i < task.assertions.length; i += 1) {
        const assertion = task.assertions[i];
        await runStep(`业务断言_${assertion.type}_${i + 1}`, async () => {
          await runAssertion(assertion, task, resolvedValues, runner);
        });
      }
    }
  } catch (_error) {
    finalStatus = 'failed';
  }

  const ended = Date.now();
  const result: Stage2ExecutionResult = {
    taskId: task.taskId,
    taskName: task.taskName,
    startedAt,
    endedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
    status: finalStatus,
    taskFilePath,
    runDir,
    resolvedValues,
    querySnapshots,
    steps,
  };

  const resultFile = path.join(runDir, 'result.json');
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
  return result;
}
