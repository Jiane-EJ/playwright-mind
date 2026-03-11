import fs from 'fs';
import path from 'path';
import type { Locator, Page } from '@playwright/test';
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

type RunStepOptions = {
  required?: boolean;
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

function resolveFieldValues(task: AcceptanceTask): Record<string, string> {
  const result: Record<string, string> = {};
  task.form.fields.forEach((field) => {
    result[field.label] = toDisplayValue(field.value);
  });
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLabel(label: string): string {
  return label.replace(/\*/g, '').trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  const filtered = values
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(filtered)];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

function isFieldValueEmpty(field: TaskField): boolean {
  if (Array.isArray(field.value)) {
    return field.value.length === 0;
  }
  return String(field.value).trim().length === 0;
}

async function pickFirstVisibleLocator(
  candidates: Locator[],
): Promise<Locator | null> {
  for (let i = 0; i < candidates.length; i += 1) {
    const locator = candidates[i];
    try {
      const count = await locator.count();
      for (let j = 0; j < count; j += 1) {
        const item = locator.nth(j);
        if (await item.isVisible()) {
          return item;
        }
      }
    } catch (_error) {
      // ignore
    }
  }
  return null;
}

async function getVisibleNth(
  locator: Locator,
  visibleIndex: number,
): Promise<Locator | null> {
  try {
    const count = await locator.count();
    let currentVisible = 0;
    for (let i = 0; i < count; i += 1) {
      const item = locator.nth(i);
      if (await item.isVisible()) {
        if (currentVisible === visibleIndex) {
          return item;
        }
        currentVisible += 1;
      }
    }
  } catch (_error) {
    // ignore
  }
  return null;
}

function buildCascaderInputCandidates(
  fieldLabel: string,
  task: AcceptanceTask,
  page: Page,
): Locator[] {
  const normalized = normalizeLabel(fieldLabel);
  const escaped = escapeRegExp(normalized);
  const dialogText = task.form.dialogTitle || task.form.openButtonText;
  const dialog = page
    .locator('div[role="dialog"], .el-dialog, .ant-modal, .ivu-modal')
    .filter({ hasText: dialogText })
    .first();
  return [
    page.getByRole('textbox', { name: new RegExp(escaped) }),
    dialog.locator(
      'input[placeholder*="省市区"], input[placeholder*="请选择省市区"], input[readonly], .el-cascader input, .ant-cascader-input, .ivu-cascader input',
    ),
    page.locator(
      'input[placeholder*="省市区"], input[placeholder*="请选择省市区"], .el-cascader input, .ant-cascader-input, .ivu-cascader input',
    ),
  ];
}

async function getActiveDialogLocator(
  task: AcceptanceTask,
  page: Page,
): Promise<Locator | null> {
  const containers = page.locator(
    'div[role="dialog"], .el-dialog__wrapper, .el-dialog, .ant-modal-wrap, .ant-modal, .ivu-modal-wrap, .ivu-modal',
  );
  const count = await containers.count();
  if (count <= 0) {
    return null;
  }
  const dialogTitle = task.form.dialogTitle;
  const normalizedTitle = dialogTitle ? normalizeText(dialogTitle) : '';
  for (let i = 0; i < count; i += 1) {
    const item = containers.nth(i);
    if (!(await item.isVisible())) {
      continue;
    }
    if (!normalizedTitle) {
      return item;
    }
    const text = normalizeText((await item.innerText()) || '');
    if (text.includes(normalizedTitle)) {
      return item;
    }
  }
  return null;
}

async function fillByCandidates(
  root: Locator,
  candidates: string[],
  value: string,
): Promise<boolean> {
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i].trim();
    if (!candidate) {
      continue;
    }
    const byPlaceholder = root.locator(
      `input[placeholder*="${candidate}"], textarea[placeholder*="${candidate}"]`,
    );
    if (await tryFillLocator(byPlaceholder, value)) {
      return true;
    }
  }
  return false;
}

function extractHintCandidates(field: TaskField): string[] {
  const hints = field.hints || [];
  const values: string[] = [];
  for (let i = 0; i < hints.length; i += 1) {
    const hint = hints[i];
    const match = hint.match(/占位文案为\s*([^\s，。；]+)/);
    if (match && match[1]) {
      values.push(match[1].trim());
    }
  }
  return uniqueNonEmpty(values);
}

async function readInputDisplayValue(locator: Locator): Promise<string> {
  try {
    const value = await locator.inputValue();
    if (value.trim().length > 0) {
      return value.trim();
    }
  } catch (_error) {
    // ignore
  }
  try {
    const valueAttr = await locator.getAttribute('value');
    if (valueAttr && valueAttr.trim().length > 0) {
      return valueAttr.trim();
    }
  } catch (_error) {
    // ignore
  }
  return '';
}

async function readCascaderDisplayValue(
  fieldLabel: string,
  task: AcceptanceTask,
  page: Page,
): Promise<string> {
  const input = await pickFirstVisibleLocator(
    buildCascaderInputCandidates(fieldLabel, task, page),
  );
  if (!input) {
    return '';
  }
  return readInputDisplayValue(input);
}

function matchCascaderPath(actualValue: string, levels: string[]): boolean {
  const normalizedActual = normalizeText(actualValue);
  const expectedPath = levels.join('/');
  const normalizedExpected = normalizeText(expectedPath);
  if (normalizedActual.includes(normalizedExpected)) {
    return true;
  }
  const normalizedActualNoSlash = normalizedActual.replace(/\//g, '');
  const normalizedExpectedNoSlash = normalizedExpected.replace(/\//g, '');
  return normalizedActualNoSlash.includes(normalizedExpectedNoSlash);
}

async function collectValidationMessages(
  page: Page,
  scope?: Locator,
): Promise<string[]> {
  const root = scope || page.locator('body');
  const selectors = [
    '.el-form-item__error',
    '.ant-form-item-explain-error',
    '.ivu-form-item-error-tip',
  ];
  const messages: string[] = [];
  for (let i = 0; i < selectors.length; i += 1) {
    const locator = root.locator(selectors[i]);
    const count = await locator.count();
    for (let j = 0; j < count; j += 1) {
      const item = locator.nth(j);
      if (!(await item.isVisible())) {
        continue;
      }
      let text = (await item.innerText()).trim();
      if (!text) {
        text = (await item.getAttribute('placeholder'))?.trim() || '';
      }
      if (text) {
        messages.push(text);
      }
    }
  }
  return uniqueNonEmpty(messages);
}

function resolveFieldsByValidationMessages(
  fields: TaskField[],
  messages: string[],
): TaskField[] {
  if (!messages.length) {
    return [];
  }
  const normalizedMessages = messages.map((item) => normalizeText(item));
  const result: TaskField[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (isFieldValueEmpty(field)) {
      continue;
    }
    const label = normalizeText(normalizeLabel(field.label));
    const matched = normalizedMessages.some((message) => {
      if (label && message.includes(label)) {
        return true;
      }
      if (
        field.componentType === 'cascader' &&
        (message.includes('省市区') || message.includes('请选择'))
      ) {
        return true;
      }
      if (label && message.includes(`请输入${label}`)) {
        return true;
      }
      if (label && message.includes(`请选择${label}`)) {
        return true;
      }
      return false;
    });
    if (matched) {
      result.push(field);
    }
  }
  return result;
}

async function isDialogVisible(task: AcceptanceTask, page: Page): Promise<boolean> {
  const dialog = await getActiveDialogLocator(task, page);
  return dialog !== null;
}

async function tryClickLocator(
  locator: ReturnType<Page['locator']>,
): Promise<boolean> {
  try {
    const count = await locator.count();
    for (let i = 0; i < count; i += 1) {
      const item = locator.nth(i);
      if (!(await item.isVisible())) {
        continue;
      }
      await item.click({ timeout: 5000 });
      return true;
    }
  } catch (_error) {
    return false;
  }
  return false;
}

async function tryFillLocator(
  locator: Locator,
  value: string,
): Promise<boolean> {
  try {
    const count = await locator.count();
    for (let i = 0; i < count; i += 1) {
      const item = locator.nth(i);
      if (!(await item.isVisible())) {
        continue;
      }
      await item.fill(value, { timeout: 5000 });
      return true;
    }
  } catch (_error) {
    return false;
  }
  return false;
}

async function waitVisibleByText(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({
      state: 'visible',
      timeout: timeoutMs,
    });
    return true;
  } catch (_error) {
    return false;
  }
}

async function openCascaderPanel(
  fieldLabel: string,
  task: AcceptanceTask,
  runner: RunnerContext,
): Promise<void> {
  const input = await pickFirstVisibleLocator(
    buildCascaderInputCandidates(fieldLabel, task, runner.page),
  );
  if (input) {
    await input.click({ timeout: 5000 });
    return;
  }
  const normalized = normalizeLabel(fieldLabel);
  await runner.ai(
    `在弹窗“${task.form.dialogTitle || task.form.openButtonText}”中，点击字段“${normalized}”打开级联下拉。`,
  );
}

async function clickCascaderOption(
  optionName: string,
  levelIndex: number,
  runner: RunnerContext,
): Promise<void> {
  const panelSelectors = [
    '.el-cascader-panel .el-cascader-menu',
    '.el-cascader-menus .el-cascader-menu',
    '.el-cascader-menu',
    '.ant-cascader-menus .ant-cascader-menu',
    '.ant-cascader-menu',
    '.ivu-cascader-menu',
  ];
  for (let i = 0; i < panelSelectors.length; i += 1) {
    const panels = runner.page.locator(panelSelectors[i]);
    const panel = await getVisibleNth(panels, levelIndex);
    if (!panel) {
      continue;
    }
    const byExactText = await tryClickLocator(
      panel.getByText(optionName, { exact: true }),
    );
    if (byExactText) {
      return;
    }
    const byNode = await tryClickLocator(
      panel
        .locator('[role="menuitem"], .el-cascader-node, li, span, div')
        .filter({ hasText: optionName }),
    );
    if (byNode) {
      return;
    }
  }

  const roleMenus = runner.page.locator('[role="menu"]');
  const roleMenu = await getVisibleNth(roleMenus, levelIndex);
  if (roleMenu) {
    const byRoleMenuText = await tryClickLocator(
      roleMenu.getByText(optionName, { exact: true }),
    );
    if (byRoleMenuText) {
      return;
    }
  }

  const escaped = escapeRegExp(optionName);
  const byMenuItem = await tryClickLocator(
    runner.page.getByRole('menuitem', {
      name: new RegExp(`^\\s*${escaped}\\s*$`),
    }),
  );
  if (byMenuItem) {
    return;
  }
  const byMenuItemText = await tryClickLocator(
    runner.page.locator('[role="menuitem"]').filter({ hasText: optionName }),
  );
  if (byMenuItemText) {
    return;
  }
  await runner.ai(`在省市区级联面板中点击“${optionName}”`);
}

async function clickButtonWithCandidates(
  labels: string[],
  runner: RunnerContext,
): Promise<boolean> {
  const candidates = uniqueNonEmpty(labels);
  for (let i = 0; i < candidates.length; i += 1) {
    const label = candidates[i];
    const escaped = escapeRegExp(label);
    const byRole = await tryClickLocator(
      runner.page.getByRole('button', {
        name: new RegExp(`^\\s*${escaped}\\s*$`),
      }),
    );
    if (byRole) {
      return true;
    }
    const byLooseRole = await tryClickLocator(
      runner.page.getByRole('button', {
        name: new RegExp(escaped),
      }),
    );
    if (byLooseRole) {
      return true;
    }
  }
  return false;
}

async function fillTextboxWithLabel(
  label: string,
  value: string,
  runner: RunnerContext,
): Promise<boolean> {
  const escaped = escapeRegExp(label);
  const byRole = runner.page.getByRole('textbox', {
    name: new RegExp(escaped),
  });
  try {
    if ((await byRole.count()) > 0) {
      await byRole.first().fill(value, { timeout: 5000 });
      return true;
    }
  } catch (_error) {
    // ignore
  }
  const byPlaceholder = runner.page.locator(
    `input[placeholder*="${label}"], textarea[placeholder*="${label}"]`,
  );
  try {
    if ((await byPlaceholder.count()) > 0) {
      await byPlaceholder.first().fill(value, { timeout: 5000 });
      return true;
    }
  } catch (_error) {
    // ignore
  }
  return false;
}

async function triggerSearchWithFallback(
  triggerText: string | undefined,
  runner: RunnerContext,
): Promise<void> {
  const clicked = await clickButtonWithCandidates(
    [triggerText || '', '搜索', '查询', '检索', '查找'],
    runner,
  );
  if (!clicked) {
    await runner.ai(`点击按钮“${triggerText || '搜索'}”`);
  }
  await runner.page.waitForLoadState('domcontentloaded');
  await runner.page.waitForTimeout(800);
}

async function clickMenuWithFallback(
  menuName: string,
  menuHints: string,
  runner: RunnerContext,
): Promise<void> {
  const escaped = escapeRegExp(menuName);
  const clickedByRoleLink = await tryClickLocator(
    runner.page.getByRole('link', { name: new RegExp(`^\\s*${escaped}\\s*$`) }),
  );
  if (clickedByRoleLink) {
    return;
  }

  const clickedByRoleMenuItem = await tryClickLocator(
    runner.page.getByRole('menuitem', {
      name: new RegExp(`\\s*${escaped}\\s*`),
    }),
  );
  if (clickedByRoleMenuItem) {
    return;
  }

  const clickedByText = await tryClickLocator(
    runner.page.locator('a,li,span,div').filter({ hasText: menuName }),
  );
  if (clickedByText) {
    return;
  }

  await runner.ai(`点击左侧菜单“${menuName}”。${menuHints}`);
}

async function fillField(
  field: TaskField,
  task: AcceptanceTask,
  runner: RunnerContext,
  runtimeContext: {
    screenshotDir: string;
    screenshotOnStep: boolean;
  },
): Promise<void> {
  if (isFieldValueEmpty(field)) {
    return;
  }
  const hints = (field.hints || []).join('；');
  if (field.componentType === 'cascader' && Array.isArray(field.value)) {
    const levels = field.value.slice(0, 10);
    if (levels.length === 0) {
      return;
    }
    const maxRetry = 3;
    for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
      await openCascaderPanel(field.label, task, runner);
      for (let i = 0; i < levels.length; i += 1) {
        const optionName = levels[i];
        await clickCascaderOption(optionName, i, runner);
        await runner.page.waitForTimeout(500);
        if (runtimeContext.screenshotOnStep) {
          const shotFile = `cascader_${sanitizeFileName(field.label)}_a${attempt}_${String(
            i + 1,
          ).padStart(2, '0')}_${sanitizeFileName(optionName)}.png`;
          const shotPath = path.join(runtimeContext.screenshotDir, shotFile);
          await runner.page.screenshot({ path: shotPath, fullPage: true });
        }
      }
      await runner.page.waitForTimeout(500);
      const actualValue = await readCascaderDisplayValue(field.label, task, runner.page);
      if (matchCascaderPath(actualValue, levels)) {
        return;
      }
      await runner.page.keyboard.press('Escape').catch(() => undefined);
      await runner.page.waitForTimeout(300);
    }
    const finalValue = await readCascaderDisplayValue(field.label, task, runner.page);
    throw new Error(
      `级联字段“${field.label}”未成功选中。期望路径=${levels.join(
        '/',
      )}；实际值=${finalValue || '空'}`,
    );
  }
  const fieldValue = toDisplayValue(field.value);
  const dialog = await getActiveDialogLocator(task, runner.page);
  const normalizedLabel = normalizeLabel(field.label);
  const labelCandidates = uniqueNonEmpty([
    normalizedLabel,
    field.label,
    ...extractHintCandidates(field),
  ]);
  if (dialog) {
    const byRole = dialog.getByRole('textbox', {
      name: new RegExp(escapeRegExp(normalizedLabel)),
    });
    if (await tryFillLocator(byRole, fieldValue)) {
      return;
    }
    if (await fillByCandidates(dialog, labelCandidates, fieldValue)) {
      return;
    }
  }
  if (await fillByCandidates(runner.page.locator('body'), labelCandidates, fieldValue)) {
    return;
  }
  const componentTips =
    field.componentType === 'textarea'
      ? '这是多行文本输入框。'
      : '这是单行输入框。';
  await runner.ai(
    `在弹窗“${task.form.dialogTitle || task.form.openButtonText}”中，在字段“${field.label}”输入“${fieldValue}”。${componentTips}${hints}`,
  );
}

async function submitFormWithAutoFix(
  task: AcceptanceTask,
  runner: RunnerContext,
  runtimeContext: {
    screenshotDir: string;
    screenshotOnStep: boolean;
  },
): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const clicked = await clickButtonWithCandidates(
      [task.form.submitButtonText, '确定', '提交', '保存'],
      runner,
    );
    if (!clicked) {
      await runner.ai(`点击按钮“${task.form.submitButtonText}”`);
    }
    await runner.page.waitForTimeout(1000);
    const dialogOpened = await isDialogVisible(task, runner.page);
    if (!dialogOpened) {
      return;
    }

    const dialog = await getActiveDialogLocator(task, runner.page);
    const messages = await collectValidationMessages(runner.page, dialog || undefined);
    const fieldsToFix = resolveFieldsByValidationMessages(task.form.fields, messages);

    if (fieldsToFix.length > 0) {
      for (let i = 0; i < fieldsToFix.length; i += 1) {
        const field = fieldsToFix[i];
        await fillField(field, task, runner, runtimeContext);
      }
      continue;
    }
    await runner.page.waitForTimeout(1200);
    const stillOpened = await isDialogVisible(task, runner.page);
    if (!stillOpened) {
      return;
    }
  }
  const dialog = await getActiveDialogLocator(task, runner.page);
  const finalMessages = await collectValidationMessages(runner.page, dialog || undefined);
  throw new Error(
    `提交失败：已重试${maxAttempts}次，弹窗仍未关闭。校验提示=${finalMessages.join('；') || '无明显提示'}`,
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
  const screenshotOnStep = task.runtime?.screenshotOnStep === true;
  const resultFile = path.join(runDir, 'result.json');
  const progressFile = path.join(runDir, 'result.partial.json');

  const writeProgress = (
    inProgress: boolean,
    status: 'passed' | 'failed',
  ): void => {
    const now = Date.now();
    const payload = {
      taskId: task.taskId,
      taskName: task.taskName,
      startedAt,
      endedAt: new Date(now).toISOString(),
      durationMs: now - started,
      status,
      inProgress,
      taskFilePath,
      runDir,
      resolvedValues,
      querySnapshots,
      steps,
    };
    fs.writeFileSync(progressFile, JSON.stringify(payload, null, 2), 'utf-8');
  };

  writeProgress(true, 'passed');

  const runStep = async (
    stepName: string,
    handler: () => Promise<void>,
    options?: RunStepOptions,
  ): Promise<void> => {
    const required = options?.required !== false;
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
      stepResult.status = required ? 'failed' : 'skipped';
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
      writeProgress(true, required ? 'failed' : 'passed');
      if (required) {
        throw error;
      }
      return;
    }
    const stepEndedAt = Date.now();
    stepResult.endedAt = new Date(stepEndedAt).toISOString();
    stepResult.durationMs = stepEndedAt - stepStartedAt;
    steps.push(stepResult);
    writeProgress(true, 'passed');
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
      await runStep(
        '等待首页加载',
        async () => {
          const homeText = task.navigation.homeReadyText;
          const firstMenu = task.navigation?.menuPath?.[0];
          const timeoutMs = stepTimeout || 12000;
          await runner.page.waitForLoadState('domcontentloaded');
          if (firstMenu) {
            const menuVisible = await waitVisibleByText(
              runner.page,
              firstMenu,
              timeoutMs,
            );
            if (menuVisible) {
              return;
            }
          }
          const homeVisible = await waitVisibleByText(
            runner.page,
            homeText,
            timeoutMs,
          );
          if (!homeVisible) {
            throw new Error('首页加载等待超时');
          }
        },
        { required: false },
      );
    }

    if (task.navigation?.menuPath?.length) {
      for (let i = 0; i < task.navigation.menuPath.length; i += 1) {
        const menuName = task.navigation.menuPath[i];
        await runStep(`点击菜单_${menuName}`, async () => {
          const menuHints = (task.navigation?.menuHints || []).join('；');
          await clickMenuWithFallback(menuName, menuHints, runner);
        });
      }
    }

    await runStep('打开新增小区弹窗', async () => {
      await runner.ai(`点击按钮“${task.form.openButtonText}”`);
    });

    if (task.form.dialogTitle) {
      await runStep('等待新增弹窗显示', async () => {
        const visible = await waitVisibleByText(
          runner.page,
          task.form.dialogTitle,
          stepTimeout || 12000,
        );
        if (!visible) {
          throw new Error(`未检测到弹窗标题：${task.form.dialogTitle}`);
        }
      });
    }

    for (let i = 0; i < task.form.fields.length; i += 1) {
      const field = task.form.fields[i];
      await runStep(`填写字段_${field.label}`, async () => {
        await fillField(field, task, runner, {
          screenshotDir,
          screenshotOnStep,
        });
      });
    }

    await runStep('提交新增表单', async () => {
      await submitFormWithAutoFix(task, runner, {
        screenshotDir,
        screenshotOnStep,
      });
    });

    if (task.form.successText) {
      await runStep(
        '检查提交提示',
        async () => {
          await waitVisibleByText(
            runner.page,
            task.form.successText,
            8000,
          );
        },
        { required: false },
      );
    }

    if (task.form.closeButtonText) {
      await runStep('关闭新增弹窗', async () => {
        const opened = await isDialogVisible(task, runner.page);
        if (!opened) {
          return;
        }
        await runner.ai(`点击按钮“${task.form.closeButtonText}”关闭弹窗`);
      });
    }

    if (task.search) {
      const keywordField = task.search.keywordFromField || '小区名称';
      const keyword = resolvedValues[keywordField] || resolvedValues['小区名称'] || '';
      await runStep('输入搜索条件', async () => {
        const inputLabel = task.search?.inputLabel || '小区名称';
        const filled = await fillTextboxWithLabel(inputLabel, keyword, runner);
        if (!filled) {
          await runner.ai(
            `在搜索区字段“${inputLabel}”输入“${keyword}”`,
          );
        }
      });
      await runStep('点击查询按钮', async () => {
        await triggerSearchWithFallback(task.search?.triggerButtonText, runner);
      });
      await runStep('检查列表包含新增数据', async () => {
        const foundOnFirstTry = await waitVisibleByText(runner.page, keyword, 8000);
        if (foundOnFirstTry) {
          return;
        }
        const inputLabel = task.search?.inputLabel || '小区名称';
        const refilled = await fillTextboxWithLabel(inputLabel, keyword, runner);
        if (!refilled) {
          await runner.ai(`在搜索区字段“${inputLabel}”重新输入“${keyword}”`);
        }
        await triggerSearchWithFallback(task.search?.triggerButtonText, runner);
        const foundOnSecondTry = await waitVisibleByText(runner.page, keyword, 8000);
        if (foundOnSecondTry) {
          return;
        }
        await runner.aiAssert(`检查列表中存在“${keyword}”这一条小区数据`);
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

  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
  writeProgress(false, finalStatus);
  return result;
}
