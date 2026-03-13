import fs from 'fs';
import path from 'path';
import type { Locator, Page } from '@playwright/test';
import type { PlayWrightAiFixtureType } from '@midscene/web/playwright';
import { acceptanceResultDir, resolveRuntimePath } from '../../config/runtime-path';
import { createStage2PersistenceStore } from '../persistence/stage2-store';
import { loadTask, resolveTaskFilePath } from './task-loader';
import type {
  AcceptanceTask,
  Stage2ExecutionResult,
  StepResult,
  TaskAssertion,
  TaskCleanup,
  TaskCleanupAction,
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

const CAPTCHA_MODE_MANUAL = 'manual';
const CAPTCHA_MODE_AUTO = 'auto';
const CAPTCHA_MODE_FAIL = 'fail';
const CAPTCHA_MODE_IGNORE = 'ignore';
const DEFAULT_CAPTCHA_MODE = CAPTCHA_MODE_AUTO;
const DEFAULT_CAPTCHA_WAIT_TIMEOUT_MS = 120000;
const CAPTCHA_CHECK_INTERVAL_MS = 1000;
const CAPTCHA_TEXT_PATTERNS = [
  '请完成安全验证',
  '请按住滑块',
  '拖动到最右边',
  '向右滑动',
];
const CAPTCHA_SELECTOR_PATTERNS = [
  '.nc_wrapper',
  '.nc_scale',
  '[id^="nc_"][id$="_wrapper"]',
  '[class*="captcha"]',
];

type CaptchaMode =
  | typeof CAPTCHA_MODE_MANUAL
  | typeof CAPTCHA_MODE_AUTO
  | typeof CAPTCHA_MODE_FAIL
  | typeof CAPTCHA_MODE_IGNORE;

function resolveCaptchaMode(): CaptchaMode {
  const value = (process.env.STAGE2_CAPTCHA_MODE || DEFAULT_CAPTCHA_MODE)
    .trim()
    .toLowerCase();
  if (value === CAPTCHA_MODE_AUTO) {
    return CAPTCHA_MODE_AUTO;
  }
  if (value === CAPTCHA_MODE_FAIL) {
    return CAPTCHA_MODE_FAIL;
  }
  if (value === CAPTCHA_MODE_IGNORE) {
    return CAPTCHA_MODE_IGNORE;
  }
  return CAPTCHA_MODE_MANUAL;
}

function resolveCaptchaWaitTimeoutMs(): number {
  const rawValue = process.env.STAGE2_CAPTCHA_WAIT_TIMEOUT_MS;
  if (!rawValue) {
    return DEFAULT_CAPTCHA_WAIT_TIMEOUT_MS;
  }
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_CAPTCHA_WAIT_TIMEOUT_MS;
  }
  return Math.floor(parsedValue);
}

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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
}

async function captureStepScreenshotSafely(
  page: Page,
  targetPath: string,
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    await page.screenshot({ path: targetPath, fullPage: true });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      errorMessage: toErrorMessage(error),
    };
  }
}

const AUTO_PLACEHOLDER_PATTERNS: RegExp[] = [
  /^待确认/,
  /^待人工确认$/,
  /^待补充$/,
  /^待完善$/,
  /^未确认$/,
  /^占位$/,
  /^todo$/i,
  /^tbd$/i,
];

function isAutoPlaceholderValue(value: string): boolean {
  const normalized = normalizeText(value);
  if (normalized.length === 0) {
    return true;
  }
  return AUTO_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
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

function resolveCascaderExpectedLevels(levels: string[]): string[] {
  return levels.filter((level) => !isAutoPlaceholderValue(level));
}

function matchCascaderPathWithAuto(actualValue: string, levels: string[]): boolean {
  const expectedLevels = resolveCascaderExpectedLevels(levels);
  if (expectedLevels.length === 0) {
    return normalizeText(actualValue).length > 0;
  }
  return matchCascaderPath(actualValue, expectedLevels);
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

async function isLocatorVisible(locator: Locator): Promise<boolean> {
  try {
    const count = await locator.count();
    for (let i = 0; i < count; i += 1) {
      if (await locator.nth(i).isVisible()) {
        return true;
      }
    }
  } catch (_error) {
    return false;
  }
  return false;
}

async function detectCaptchaChallenge(page: Page): Promise<boolean> {
  for (let i = 0; i < CAPTCHA_TEXT_PATTERNS.length; i += 1) {
    const pattern = CAPTCHA_TEXT_PATTERNS[i];
    if (
      await isLocatorVisible(
        page.getByText(pattern, { exact: false }).first(),
      )
    ) {
      return true;
    }
  }
  for (let i = 0; i < CAPTCHA_SELECTOR_PATTERNS.length; i += 1) {
    const selector = CAPTCHA_SELECTOR_PATTERNS[i];
    if (await isLocatorVisible(page.locator(selector))) {
      return true;
    }
  }
  return false;
}

type SliderPosition = {
  x: number;
  y: number;
  width: number;
  height: number;
};

async function querySliderPosition(
  runner: RunnerContext,
): Promise<SliderPosition | null> {
  try {
    const result = await runner.aiQuery<{
      found: boolean;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }>(`
分析当前页面是否存在滑块验证码。
如果存在，返回滑块按钮的位置信息（中心点坐标和尺寸）。
返回格式：{ found: boolean, x: number, y: number, width: number, height: number }
其中 x,y 是滑块按钮中心点的屏幕坐标。
`);
    if (result && result.found && result.x !== undefined && result.y !== undefined) {
      return {
        x: result.x,
        y: result.y,
        width: result.width || 40,
        height: result.height || 40,
      };
    }
  } catch (_error) {
    // 忽略AI查询错误
  }
  return null;
}

async function querySliderTrackWidth(
  runner: RunnerContext,
): Promise<number | null> {
  try {
    const result = await runner.aiQuery<{
      found: boolean;
      width?: number;
    }>(`
分析当前页面的滑块验证码滑槽宽度。
返回格式：{ found: boolean, width: number }
width 是滑槽的总宽度（像素）。
`);
    if (result && result.found && result.width !== undefined && result.width > 0) {
      return result.width;
    }
  } catch (_error) {
    // 忽略AI查询错误
  }
  return null;
}

async function autoSolveSliderCaptcha(runner: RunnerContext): Promise<boolean> {
  console.log('[滑块自动处理] 开始检测滑块位置...');

  const sliderPos = await querySliderPosition(runner);
  if (!sliderPos) {
    console.log('[滑块自动处理] 未检测到滑块位置');
    return false;
  }

  console.log(`[滑块自动处理] 检测到滑块位置: x=${sliderPos.x}, y=${sliderPos.y}`);

  const trackWidth = await querySliderTrackWidth(runner);
  const targetX = trackWidth ? sliderPos.x + trackWidth - 50 : sliderPos.x + 250;

  console.log(`[滑块自动处理] 目标位置: x=${targetX}, y=${sliderPos.y}`);
  console.log('[滑块自动处理] 开始模拟拖动...');

  const page = runner.page;

  try {
    // 先等待一下确保页面稳定
    await page.waitForTimeout(500);

    // 移动到滑块起始位置
    await page.mouse.move(sliderPos.x, sliderPos.y);
    await page.waitForTimeout(200);

    // 按下鼠标
    await page.mouse.down();
    await page.waitForTimeout(300);

    // 模拟真人拖动轨迹：先快后慢，带小幅抖动
    const totalDistance = targetX - sliderPos.x;
    const steps = 15;
    let currentX = sliderPos.x;

    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      // 使用 easeOut 缓动函数：先快后慢
      const easeOut = 1 - Math.pow(1 - progress, 2);
      const targetStepX = sliderPos.x + totalDistance * easeOut;

      // 添加小幅随机抖动（-3 到 3 像素）
      const jitterX = (Math.random() - 0.5) * 6;
      const jitterY = (Math.random() - 0.5) * 4;

      currentX = Math.round(targetStepX + jitterX);
      const currentY = Math.round(sliderPos.y + jitterY);

      await page.mouse.move(currentX, currentY);
      // 随机延迟 30-80ms
      await page.waitForTimeout(30 + Math.random() * 50);
    }

    // 确保到达目标位置
    await page.mouse.move(targetX, sliderPos.y);
    await page.waitForTimeout(200);

    // 释放鼠标
    await page.mouse.up();
    await page.waitForTimeout(500);

    console.log('[滑块自动处理] 拖动完成，等待验证结果...');

    // 等待并检查滑块是否消失
    await page.waitForTimeout(2000);
    const stillFound = await detectCaptchaChallenge(page);

    if (!stillFound) {
      console.log('[滑块自动处理] 滑块验证成功');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(500);
      return true;
    }

    console.log('[滑块自动处理] 滑块验证可能失败，滑块仍然存在');
    return false;
  } catch (error) {
    console.error('[滑块自动处理] 拖动过程出错:', error);
    // 确保鼠标释放
    try {
      await page.mouse.up();
    } catch (_e) {
      // 忽略
    }
    return false;
  }
}

async function handleCaptchaChallengeIfNeeded(
  runner: RunnerContext,
): Promise<void> {
  const mode = resolveCaptchaMode();
  if (mode === CAPTCHA_MODE_IGNORE) {
    return;
  }
  const found = await detectCaptchaChallenge(runner.page);
  if (!found) {
    return;
  }
  if (mode === CAPTCHA_MODE_FAIL) {
    throw new Error(
      '检测到滑块/安全验证，当前配置 STAGE2_CAPTCHA_MODE=fail，不允许继续执行。',
    );
  }

  // 自动模式：尝试使用AI+Playwright自动处理滑块
  if (mode === CAPTCHA_MODE_AUTO) {
    console.log('[安全验证] 检测到滑块，使用自动模式处理...');
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[安全验证] 自动处理尝试 ${attempt}/${maxAttempts}`);
      const solved = await autoSolveSliderCaptcha(runner);
      if (solved) {
        console.log('[安全验证] 自动处理成功');
        return;
      }
      if (attempt < maxAttempts) {
        console.log('[安全验证] 自动处理失败，等待后重试...');
        await runner.page.waitForTimeout(2000);
      }
    }
    throw new Error(
      `滑块自动处理失败，已尝试${maxAttempts}次。建议：1) 检查页面截图确认滑块样式 2) 调整为 manual 模式人工处理 3) 调整滑块检测选择器`,
    );
  }

  // 人工兜底模式（默认）
  const timeoutMs = resolveCaptchaWaitTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  console.warn(
    `检测到滑块/安全验证，请手动完成；系统将在 ${timeoutMs}ms 内持续等待验证消失。`,
  );
  while (Date.now() < deadline) {
    const stillFound = await detectCaptchaChallenge(runner.page);
    if (!stillFound) {
      await runner.page.waitForLoadState('domcontentloaded');
      await runner.page.waitForTimeout(500);
      return;
    }
    await runner.page.waitForTimeout(CAPTCHA_CHECK_INTERVAL_MS);
  }
  throw new Error(
    `滑块/安全验证在 ${timeoutMs}ms 内未完成，任务终止。可调整 STAGE2_CAPTCHA_WAIT_TIMEOUT_MS 增大等待时间。`,
  );
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
  if (isAutoPlaceholderValue(optionName)) {
    for (let i = 0; i < panelSelectors.length; i += 1) {
      const panels = runner.page.locator(panelSelectors[i]);
      const panel = await getVisibleNth(panels, levelIndex);
      if (!panel) {
        continue;
      }
      const clicked = await tryClickLocator(
        panel.locator(
          '.el-cascader-node:not(.is-disabled), .ant-cascader-menu-item:not(.ant-cascader-menu-item-disabled), .ivu-cascader-menu-item:not(.ivu-cascader-menu-item-disabled), [role="menuitem"]:not([aria-disabled="true"]), li:not(.is-disabled):not(.disabled):not([aria-disabled="true"])',
        ),
      );
      if (clicked) {
        return;
      }
    }
    const roleMenus = runner.page.locator('[role="menu"]');
    const roleMenu = await getVisibleNth(roleMenus, levelIndex);
    if (roleMenu) {
      const clicked = await tryClickLocator(
        roleMenu.locator('[role="menuitem"]:not([aria-disabled="true"])'),
      );
      if (clicked) {
        return;
      }
    }
    return;
  }

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
  await handleCaptchaChallengeIfNeeded(runner);
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
    const expectedLevels = resolveCascaderExpectedLevels(levels);
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
      if (matchCascaderPathWithAuto(actualValue, levels)) {
        return;
      }
      await runner.page.keyboard.press('Escape').catch(() => undefined);
      await runner.page.waitForTimeout(300);
    }
    const finalValue = await readCascaderDisplayValue(field.label, task, runner.page);
    if (expectedLevels.length === 0) {
      // 占位值场景无法稳定选中时不直接中断，交由后续提交流程做必填校验兜底。
      return;
    }
    const expectedPath = expectedLevels.length > 0
      ? expectedLevels.join('/')
      : '自动选择当前层首个可用项';
    throw new Error(
      `级联字段“${field.label}”未成功选中。期望路径=${expectedPath}；原始值=${levels.join(
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

// ============================================================
// 断言执行器 - 通用实现（Playwright优先 + AI兜底 + 重试机制）
// ============================================================

const DEFAULT_ASSERTION_TIMEOUT_MS = 15000;
const DEFAULT_ASSERTION_RETRY_COUNT = 2;
const ASSERTION_POLL_INTERVAL_MS = 500;
const DEFAULT_TABLE_ROW_SELECTORS = [
  'table tbody tr',
  '.el-table__body tr',
  '.ant-table-tbody tr',
  '.ivu-table-tbody tr',
  '[role="row"]',
];
const DEFAULT_TOAST_SELECTORS = [
  '.el-message',
  '.el-notification',
  '.ant-message',
  '.ant-notification',
  '.ivu-message',
  '.ivu-notice',
  '[role="alert"]',
  '[class*="toast"]',
  '[class*="message"]',
  '[class*="notification"]',
];
const DEFAULT_DIALOG_SELECTORS = [
  'div[role="dialog"]',
  '.el-dialog__wrapper',
  '.el-message-box__wrapper',
  '.ant-modal-wrap',
  '.ant-modal-confirm',
  '.ivu-modal-wrap',
  '[class*="confirm"]',
  '[class*="modal"]',
];

type RowMatchMode = 'exact' | 'contains';

function resolveRowMatchMode(
  mode: TaskAssertion['matchMode'] | TaskCleanup['rowMatchMode'] | undefined,
): RowMatchMode {
  if (mode === 'contains') {
    return 'contains';
  }
  return 'exact';
}

function resolveTableRowSelectors(task: AcceptanceTask): string[] {
  return uniqueNonEmpty([
    ...(task.uiProfile?.tableRowSelectors || []),
    ...DEFAULT_TABLE_ROW_SELECTORS,
  ]);
}

function resolveToastSelectors(task: AcceptanceTask): string[] {
  return uniqueNonEmpty([
    ...(task.uiProfile?.toastSelectors || []),
    ...DEFAULT_TOAST_SELECTORS,
  ]);
}

function resolveDialogSelectors(task: AcceptanceTask): string[] {
  return uniqueNonEmpty([
    ...(task.uiProfile?.dialogSelectors || []),
    ...DEFAULT_DIALOG_SELECTORS,
  ]);
}

function normalizeLookupKey(value: string): string {
  return normalizeText(value).toLowerCase();
}

function resolveExpectedValueForColumn(
  column: string,
  resolvedValues: Record<string, string>,
): string | undefined {
  if (resolvedValues[column]) {
    return resolvedValues[column];
  }
  const targetKey = normalizeLookupKey(column);
  const entries = Object.entries(resolvedValues);
  for (let i = 0; i < entries.length; i += 1) {
    const [key, value] = entries[i];
    if (normalizeLookupKey(key) === targetKey && value) {
      return value;
    }
  }
  const fuzzyCandidates: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const [key, value] = entries[i];
    const normalizedKey = normalizeLookupKey(key);
    if (
      value &&
      (normalizedKey.includes(targetKey) || targetKey.includes(normalizedKey))
    ) {
      fuzzyCandidates.push(value);
    }
  }
  if (fuzzyCandidates.length === 1) {
    return fuzzyCandidates[0];
  }
  return undefined;
}

function buildExpectedColumnMap(
  assertion: TaskAssertion,
  resolvedValues: Record<string, string>,
): Record<string, string> {
  const expectedMap: Record<string, string> = {};
  const columns = assertion.expectedColumns || [];
  for (let i = 0; i < columns.length; i += 1) {
    const column = columns[i];
    const literal = assertion.expectedColumnValues?.[column];
    if (literal && literal.trim()) {
      expectedMap[column] = literal.trim();
      continue;
    }
    const fromField = assertion.expectedColumnFromFields?.[column];
    if (fromField && resolvedValues[fromField]) {
      expectedMap[column] = resolvedValues[fromField];
      continue;
    }
    const inferred = resolveExpectedValueForColumn(column, resolvedValues);
    if (inferred && inferred.trim()) {
      expectedMap[column] = inferred.trim();
    }
  }
  return expectedMap;
}

function normalizeStructuredText(value: string): string {
  return value.replace(/[\s/＞>→]+/g, '').trim();
}

function isExactComparableMatch(actualValue: string, expectedValue: string): boolean {
  const normalizedActual = normalizeText(actualValue);
  const normalizedExpected = normalizeText(expectedValue);
  if (normalizedActual === normalizedExpected) {
    return true;
  }
  const hasStructuredSeparator = /[/＞>→]/.test(actualValue) || /[/＞>→]/.test(expectedValue);
  if (!hasStructuredSeparator) {
    return false;
  }
  return normalizeStructuredText(actualValue) === normalizeStructuredText(expectedValue);
}

function isContainsComparableMatch(actualValue: string, expectedValue: string): boolean {
  const normalizedActual = normalizeText(actualValue);
  const normalizedExpected = normalizeText(expectedValue);
  if (normalizedActual.includes(normalizedExpected)) {
    return true;
  }
  const hasStructuredSeparator = /[/＞>→]/.test(actualValue) || /[/＞>→]/.test(expectedValue);
  if (!hasStructuredSeparator) {
    return false;
  }
  return normalizeStructuredText(actualValue).includes(normalizeStructuredText(expectedValue));
}

function resolveColumnValue(
  columnValues: Record<string, string>,
  column: string,
): string | undefined {
  if (columnValues[column]) {
    return columnValues[column];
  }
  const targetKey = normalizeLookupKey(column);
  const entries = Object.entries(columnValues);
  for (let i = 0; i < entries.length; i += 1) {
    const [key, value] = entries[i];
    if (normalizeLookupKey(key) === targetKey && value) {
      return value;
    }
  }
  for (let i = 0; i < entries.length; i += 1) {
    const [key, value] = entries[i];
    const normalizedKey = normalizeLookupKey(key);
    if (
      value &&
      (normalizedKey.includes(targetKey) || targetKey.includes(normalizedKey))
    ) {
      return value;
    }
  }
  return undefined;
}

function formatColumnAssertionDetail(
  expectedColumnMap: Record<string, string>,
  actualColumnValues?: Record<string, string>,
  missingColumns?: string[],
  mismatchedColumns?: string[],
): string {
  const parts: string[] = [];
  if (missingColumns?.length) {
    parts.push(`缺少列：${missingColumns.join('、')}`);
  }
  if (mismatchedColumns?.length) {
    const mismatchText = mismatchedColumns
      .map((column) => {
        const expected = expectedColumnMap[column] || '';
        const actual = actualColumnValues?.[column] || '';
        return `${column}[expected=${expected}; actual=${actual}]`;
      })
      .join('；');
    parts.push(`列值不匹配：${mismatchText}`);
  }
  return parts.join('；');
}

async function matchRowByCellValue(
  row: Locator,
  cellValue: string,
  matchMode: RowMatchMode,
): Promise<boolean> {
  const normalizedValue = normalizeText(cellValue);
  if (!normalizedValue) {
    return false;
  }
  const cellLocator = row.locator(
    'td, th, [role="cell"], .cell, .ant-table-cell, .ivu-table-cell',
  );
  const cellCount = await cellLocator.count().catch(() => 0);
  if (cellCount > 0) {
    for (let i = 0; i < cellCount; i += 1) {
      const cell = cellLocator.nth(i);
      const cellText = normalizeText(await cell.innerText().catch(() => ''));
      if (!cellText) {
        continue;
      }
      if (matchMode === 'exact' && cellText === normalizedValue) {
        return true;
      }
      if (matchMode === 'contains' && cellText.includes(normalizedValue)) {
        return true;
      }
    }
    return false;
  }
  const rowText = normalizeText(await row.innerText().catch(() => ''));
  if (!rowText) {
    return false;
  }
  if (matchMode === 'exact') {
    return rowText === normalizedValue;
  }
  return rowText.includes(normalizedValue);
}

/**
 * 通用文本可见性检测（Playwright 硬检测）
 * 支持多种文本匹配模式
 */
async function detectTextVisible(
  page: Page,
  text: string,
  timeoutMs: number,
  toastSelectors: string[] = DEFAULT_TOAST_SELECTORS,
): Promise<{ found: boolean; matchedText?: string }> {
  const deadline = Date.now() + timeoutMs;
  const normalizedTarget = normalizeText(text);

  while (Date.now() < deadline) {
    try {
      // 策略1：精确文本匹配
      const exactLocator = page.getByText(text, { exact: true });
      if (await isLocatorVisible(exactLocator)) {
        return { found: true, matchedText: text };
      }

      // 策略2：模糊文本匹配
      const fuzzyLocator = page.getByText(text, { exact: false });
      if (await isLocatorVisible(fuzzyLocator)) {
        return { found: true, matchedText: text };
      }

      // 策略3：Toast/Message 组件检测
      for (let i = 0; i < toastSelectors.length; i += 1) {
        const toastLocator = page.locator(toastSelectors[i]);
        const count = await toastLocator.count();
        for (let j = 0; j < count; j += 1) {
          const item = toastLocator.nth(j);
          if (!(await item.isVisible())) {
            continue;
          }
          const itemText = await item.innerText().catch(() => '');
          if (normalizeText(itemText).includes(normalizedTarget)) {
            return { found: true, matchedText: itemText.trim() };
          }
        }
      }
    } catch (_error) {
      // 忽略检测异常，继续轮询
    }
    await page.waitForTimeout(ASSERTION_POLL_INTERVAL_MS);
  }
  return { found: false };
}

/**
 * 通用表格行检测（Playwright 硬检测）
 */
async function detectTableRowExists(
  page: Page,
  cellValue: string,
  timeoutMs: number,
  opts?: {
    tableSelectors?: string[];
    matchMode?: RowMatchMode;
  },
): Promise<{ found: boolean; rowIndex?: number }> {
  const normalizedValue = normalizeText(cellValue);
  if (!normalizedValue) {
    return { found: false };
  }
  const deadline = Date.now() + timeoutMs;
  const tableSelectors = opts?.tableSelectors?.length
    ? opts.tableSelectors
    : DEFAULT_TABLE_ROW_SELECTORS;
  const matchMode = resolveRowMatchMode(opts?.matchMode);

  while (Date.now() < deadline) {
    try {
      for (let i = 0; i < tableSelectors.length; i += 1) {
        const rows = page.locator(tableSelectors[i]);
        const count = await rows.count();
        for (let j = 0; j < count; j += 1) {
          const row = rows.nth(j);
          if (!(await row.isVisible())) {
            continue;
          }
          if (await matchRowByCellValue(row, normalizedValue, matchMode)) {
            return { found: true, rowIndex: j };
          }
        }
      }
    } catch (_error) {
      // 忽略检测异常，继续轮询
    }
    await page.waitForTimeout(ASSERTION_POLL_INTERVAL_MS);
  }
  return { found: false };
}

async function extractRowColumnValues(
  row: Locator,
): Promise<{ rowText: string; columnValues: Record<string, string> }> {
  return row.evaluate((element) => {
    const normalize = (value: string | null | undefined): string =>
      (value || '').replace(/\s+/g, ' ').trim();
    const rowEl = element as HTMLElement;

    const readTexts = (elements: Element[]): string[] =>
      elements
        .map((item) => normalize((item as HTMLElement).innerText || item.textContent))
        .filter((item) => item.length > 0);

    const cellSelectors = [
      ':scope > td',
      ':scope > th',
      ':scope > [role="cell"]',
      ':scope > .ant-table-cell',
      ':scope > .ivu-table-cell',
      ':scope > .cell',
    ];
    let cellTexts: string[] = [];
    for (let i = 0; i < cellSelectors.length; i += 1) {
      const cells = readTexts(Array.from(rowEl.querySelectorAll(cellSelectors[i])));
      if (cells.length > 0) {
        cellTexts = cells;
        break;
      }
    }
    if (cellTexts.length === 0) {
      cellTexts = readTexts(Array.from(rowEl.children));
    }

    const isTableContainer = (node: Element | null): node is HTMLElement => {
      if (!node || !(node instanceof HTMLElement)) {
        return false;
      }
      const className = `${node.className || ''}`.toLowerCase();
      const role = `${node.getAttribute('role') || ''}`.toLowerCase();
      return (
        node.tagName === 'TABLE' ||
        role === 'table' ||
        className.includes('el-table') ||
        className.includes('ant-table') ||
        className.includes('ivu-table')
      );
    };

    let container: HTMLElement | null = null;
    let current: HTMLElement | null = rowEl;
    while (current) {
      if (isTableContainer(current)) {
        container = current;
        if (current.tagName !== 'TABLE') {
          break;
        }
      }
      current = current.parentElement;
    }
    const headerSelectors = [
      'thead th',
      '.el-table__header th',
      '.ant-table-thead th',
      '.ivu-table-header th',
      '[role="columnheader"]',
    ];
    let headerTexts: string[] = [];
    if (container) {
      for (let i = 0; i < headerSelectors.length; i += 1) {
        const headers = readTexts(Array.from(container.querySelectorAll(headerSelectors[i])));
        if (headers.length > 0) {
          headerTexts = headers;
          break;
        }
      }
    }

    const columnValues: Record<string, string> = {};
    const columnCount = Math.min(headerTexts.length, cellTexts.length);
    for (let i = 0; i < columnCount; i += 1) {
      const header = headerTexts[i];
      const cell = cellTexts[i];
      if (header && !(header in columnValues)) {
        columnValues[header] = cell;
      }
    }

    return {
      rowText: normalize(rowEl.innerText || rowEl.textContent),
      columnValues,
    };
  });
}

async function detectTableRowColumnValues(
  page: Page,
  rowValue: string,
  columns: string[],
  timeoutMs: number,
  opts?: {
    tableSelectors?: string[];
    matchMode?: RowMatchMode;
  },
): Promise<{
  found: boolean;
  rowText?: string;
  columnValues?: Record<string, string>;
  missingColumns?: string[];
}> {
  const normalizedValue = normalizeText(rowValue);
  if (!normalizedValue) {
    return { found: false };
  }
  const deadline = Date.now() + timeoutMs;
  const tableSelectors = opts?.tableSelectors?.length
    ? opts.tableSelectors
    : DEFAULT_TABLE_ROW_SELECTORS;
  const matchMode = resolveRowMatchMode(opts?.matchMode);

  while (Date.now() < deadline) {
    try {
      for (let i = 0; i < tableSelectors.length; i += 1) {
        const rows = page.locator(tableSelectors[i]);
        const count = await rows.count();
        for (let j = 0; j < count; j += 1) {
          const row = rows.nth(j);
          if (!(await row.isVisible())) {
            continue;
          }
          if (!(await matchRowByCellValue(row, normalizedValue, matchMode))) {
            continue;
          }
          const rowSnapshot = await extractRowColumnValues(row);
          const columnValues: Record<string, string> = {};
          const missingColumns: string[] = [];
          for (let k = 0; k < columns.length; k += 1) {
            const column = columns[k];
            const actualValue = resolveColumnValue(rowSnapshot.columnValues, column);
            if (actualValue === undefined) {
              missingColumns.push(column);
              continue;
            }
            columnValues[column] = actualValue;
          }
          return {
            found: true,
            rowText: rowSnapshot.rowText,
            columnValues,
            missingColumns,
          };
        }
      }
    } catch (_error) {
      // 忽略检测异常，继续轮询
    }
    await page.waitForTimeout(ASSERTION_POLL_INTERVAL_MS);
  }
  return { found: false };
}

/**
 * 带重试的断言执行器
 */
async function executeAssertionWithRetry<T>(
  executor: () => Promise<T>,
  validator: (result: T) => boolean,
  retryCount: number,
  delayMs: number = 1000,
): Promise<{ success: boolean; result?: T; attempts: number }> {
  let attempts = 0;
  let lastResult: T | undefined;
  while (attempts <= retryCount) {
    attempts += 1;
    try {
      const result = await executor();
      lastResult = result;
      if (validator(result)) {
        return { success: true, result, attempts };
      }
    } catch (_error) {
      // 重试
    }
    if (attempts <= retryCount) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { success: false, result: lastResult, attempts };
}

/**
 * 通用断言执行入口
 * 策略：Playwright 硬检测优先 -> AI 断言兜底 -> 重试机制
 */
async function runAssertion(
  assertion: TaskAssertion,
  task: AcceptanceTask,
  resolvedValues: Record<string, string>,
  runner: RunnerContext,
): Promise<void> {
  const timeoutMs = assertion.timeoutMs || DEFAULT_ASSERTION_TIMEOUT_MS;
  const retryCount = assertion.retryCount ?? DEFAULT_ASSERTION_RETRY_COUNT;
  const toastSelectors = resolveToastSelectors(task);
  const tableSelectors = resolveTableRowSelectors(task);

  // Toast 断言：Playwright 检测优先，AI 兜底
  if (assertion.type === 'toast' && assertion.expectedText) {
    const expectedText = assertion.expectedText;

    // 先用 Playwright 硬检测
    const pwResult = await executeAssertionWithRetry(
      async () => detectTextVisible(
        runner.page,
        expectedText,
        timeoutMs / 2,
        toastSelectors,
      ),
      (r) => r.found,
      1,
      500,
    );
    if (pwResult.success) {
      console.log(`[断言通过] toast="${expectedText}" (Playwright检测, 尝试${pwResult.attempts}次)`);
      return;
    }

    // Playwright 未检测到，使用 AI 兜底
    console.log(`[断言降级] toast="${expectedText}" Playwright未检测到，使用AI断言`);
    const aiResult = await executeAssertionWithRetry(
      async () => {
        const queryResult = await runner.aiQuery<{ found: boolean; text?: string }>(
          `检查页面是否存在包含"${expectedText}"的提示信息（如Toast、弹窗、通知等）。返回格式：{ found: boolean, text: string }`,
        );
        return queryResult;
      },
      (r) => r?.found === true,
      retryCount,
      1000,
    );
    if (aiResult.success) {
      console.log(`[断言通过] toast="${expectedText}" (AI检测, 尝试${aiResult.attempts}次)`);
      return;
    }

    throw new Error(
      `Toast断言失败：未检测到"${expectedText}"。已尝试Playwright硬检测和AI检测。`,
    );
  }

  // 表格行存在断言
  if (assertion.type === 'table-row-exists' && assertion.matchField) {
    const expectedValue = resolvedValues[assertion.matchField] || '';
    if (!normalizeText(expectedValue)) {
      throw new Error(
        `表格行断言配置无效：matchField="${assertion.matchField}" 未解析到有效值`,
      );
    }
    const rowMatchMode = resolveRowMatchMode(assertion.matchMode);

    // 先用 Playwright 硬检测
    const pwResult = await executeAssertionWithRetry(
      async () =>
        detectTableRowExists(runner.page, expectedValue, timeoutMs / 2, {
          tableSelectors,
          matchMode: rowMatchMode,
        }),
      (r) => r.found,
      1,
      500,
    );
    if (pwResult.success) {
      console.log(`[断言通过] table-row-exists="${expectedValue}" (Playwright检测)`);
      return;
    }

    // AI 兜底
    console.log(`[断言降级] table-row-exists="${expectedValue}" 使用AI断言`);
    const aiResult = await executeAssertionWithRetry(
      async () => {
        const queryResult = await runner.aiQuery<{ found: boolean; rowInfo?: string }>(
          `检查当前页面列表/表格中是否存在${
            rowMatchMode === 'exact' ? '精确匹配' : '包含匹配'
          }"${expectedValue}"的数据行。返回格式：{ found: boolean, rowInfo: string }`,
        );
        return queryResult;
      },
      (r) => r?.found === true,
      retryCount,
      1000,
    );
    if (aiResult.success) {
      console.log(`[断言通过] table-row-exists="${expectedValue}" (AI检测)`);
      return;
    }

    throw new Error(
      `表格行断言失败：未找到${
        rowMatchMode === 'exact' ? '精确匹配' : '包含匹配'
      }"${expectedValue}"的数据行。`,
    );
  }

  // 表格单元格值断言
  if (assertion.type === 'table-cell-equals' && assertion.matchField) {
    const expectedValue = resolvedValues[assertion.matchField] || '';
    if (!normalizeText(expectedValue)) {
      throw new Error(
        `表格单元格断言配置无效：matchField="${assertion.matchField}" 未解析到有效值`,
      );
    }
    const expectedColumns = uniqueNonEmpty(assertion.expectedColumns || []);
    if (expectedColumns.length === 0) {
      throw new Error('表格单元格断言配置无效：expectedColumns 不能为空');
    }
    const expectedColumnMap = buildExpectedColumnMap(assertion, resolvedValues);
    if (Object.keys(expectedColumnMap).length === 0) {
      throw new Error(
        '表格单元格断言配置无效：未解析到任何期望列值，请补充 expectedColumnValues 或 expectedColumnFromFields',
      );
    }
    const missingExpectedColumns = expectedColumns.filter(
      (column) => !expectedColumnMap[column],
    );
    if (missingExpectedColumns.length > 0) {
      throw new Error(
        `表格单元格断言配置无效：以下列缺少期望值映射 ${missingExpectedColumns.join('、')}`,
      );
    }

    const pwResult = await executeAssertionWithRetry(
      async () => {
        const queryResult = await detectTableRowColumnValues(
          runner.page,
          expectedValue,
          expectedColumns,
          timeoutMs / 2,
          {
            tableSelectors,
            matchMode: resolveRowMatchMode(assertion.matchMode),
          },
        );
        if (!queryResult.found || queryResult.missingColumns?.length) {
          return queryResult;
        }
        const actualColumnValues = queryResult.columnValues || {};
        const mismatchedColumns = expectedColumns.filter(
          (column) =>
            !isExactComparableMatch(
              actualColumnValues[column] || '',
              expectedColumnMap[column] || '',
            ),
        );
        return {
          ...queryResult,
          allMatched: mismatchedColumns.length === 0,
          mismatchedColumns,
        };
      },
      (r) =>
        r.found === true &&
        (!r.missingColumns || r.missingColumns.length === 0) &&
        r.allMatched === true,
      retryCount,
      1000,
    );
    if (pwResult.success) {
      console.log(`[断言通过] table-cell-equals (Playwright检测)`);
      return;
    }

    console.log(`[断言降级] table-cell-equals 使用AI断言`);
    const aiResult = await executeAssertionWithRetry(
      async () => {
        const queryResult = await runner.aiQuery<{
          found: boolean;
          matchedRow?: boolean;
          allMatched?: boolean;
          mismatchedColumns?: string[];
          columnValues?: Record<string, string>;
        }>(
          `在当前列表中找到"${assertion.matchField}"为"${expectedValue}"的行，提取列${JSON.stringify(
            expectedColumns,
          )}的值，并与期望值${JSON.stringify(
            expectedColumnMap,
          )}做严格比对。返回格式：{ found: boolean, matchedRow: boolean, allMatched: boolean, mismatchedColumns: string[], columnValues: { 列名: 值 } }`,
        );
        return queryResult;
      },
      (r) =>
        r?.found === true && r?.matchedRow === true && r?.allMatched === true,
      retryCount,
      1000,
    );
    if (aiResult.success) {
      console.log(`[断言通过] table-cell-equals (AI检测)`);
      return;
    }

    const pwDetail = pwResult.result
      ? formatColumnAssertionDetail(
          expectedColumnMap,
          pwResult.result.columnValues,
          pwResult.result.missingColumns,
          pwResult.result.mismatchedColumns,
        )
      : '';
    const aiDetail = aiResult.result
      ? formatColumnAssertionDetail(
          expectedColumnMap,
          aiResult.result.columnValues,
          [],
          aiResult.result.mismatchedColumns,
        )
      : '';
    const detailText = uniqueNonEmpty([pwDetail, aiDetail]).join('；');
    throw new Error(
      `表格单元格断言失败：未能验证"${assertion.matchField}"为"${expectedValue}"的行中相关列的值。${
        detailText ? ` 详情：${detailText}` : ''
      }`,
    );
  }

  // 表格单元格包含断言
  if (
    assertion.type === 'table-cell-contains' &&
    assertion.matchField &&
    assertion.column &&
    assertion.expectedFromField
  ) {
    const matchValue = resolvedValues[assertion.matchField] || '';
    const expectedValue = resolvedValues[assertion.expectedFromField] || '';
    if (!normalizeText(matchValue)) {
      throw new Error(
        `表格单元格包含断言配置无效：matchField="${assertion.matchField}" 未解析到有效值`,
      );
    }
    if (!normalizeText(expectedValue)) {
      throw new Error(
        `表格单元格包含断言配置无效：expectedFromField="${assertion.expectedFromField}" 未解析到有效值`,
      );
    }

    const pwResult = await executeAssertionWithRetry(
      async () => {
        const queryResult = await detectTableRowColumnValues(
          runner.page,
          matchValue,
          [assertion.column],
          timeoutMs / 2,
          {
            tableSelectors,
            matchMode: resolveRowMatchMode(assertion.matchMode),
          },
        );
        const actualValue = queryResult.columnValues?.[assertion.column] || '';
        return {
          ...queryResult,
          cellValue: actualValue,
          contains: isContainsComparableMatch(actualValue, expectedValue),
        };
      },
      (r) =>
        r.found === true &&
        (!r.missingColumns || r.missingColumns.length === 0) &&
        r.contains === true,
      retryCount,
      1000,
    );
    if (pwResult.success) {
      console.log(`[断言通过] table-cell-contains (Playwright检测)`);
      return;
    }

    console.log(`[断言降级] table-cell-contains 使用AI断言`);
    const aiResult = await executeAssertionWithRetry(
      async () => {
        const queryResult = await runner.aiQuery<{
          found: boolean;
          cellValue?: string;
          contains?: boolean;
        }>(
          `在当前列表中找到"${assertion.matchField}"为"${matchValue}"的行，检查列"${assertion.column}"是否包含"${expectedValue}"。返回格式：{ found: boolean, cellValue: string, contains: boolean }`,
        );
        return queryResult;
      },
      (r) =>
        r?.found === true &&
        normalizeText(r?.cellValue || '').includes(normalizeText(expectedValue)),
      retryCount,
      1000,
    );
    if (aiResult.success) {
      console.log(`[断言通过] table-cell-contains (AI检测)`);
      return;
    }

    const actualValue =
      pwResult.result?.cellValue || aiResult.result?.cellValue || '';
    throw new Error(
      `表格单元格包含断言失败：列"${assertion.column}"未包含"${expectedValue}"。${
        actualValue ? ` 实际值：${actualValue}` : ''
      }`,
    );
  }

  // 自定义描述断言
  if (assertion.type === 'custom' && assertion.description) {
    const aiResult = await executeAssertionWithRetry(
      async () => {
        const queryResult = await runner.aiQuery<{ passed: boolean; reason?: string }>(
          `根据以下描述验证当前页面状态："${assertion.description}"。返回格式：{ passed: boolean, reason: string }`,
        );
        return queryResult;
      },
      (r) => r?.passed === true,
      retryCount,
      1000,
    );
    if (aiResult.success) {
      console.log(`[断言通过] custom="${assertion.description}" (AI检测)`);
      return;
    }

    throw new Error(
      `自定义断言失败：${assertion.description}`,
    );
  }

  // 保底策略：未知断言类型使用 aiQuery 结构化验证
  console.log(`[断言] 未知类型="${assertion.type}"，使用AI通用断言`);
  const aiResult = await executeAssertionWithRetry(
    async () => {
      const queryResult = await runner.aiQuery<{ passed: boolean; reason?: string }>(
        `根据当前页面内容执行断言验证：${JSON.stringify(assertion)}。返回格式：{ passed: boolean, reason: string }`,
      );
      return queryResult;
    },
    (r) => r?.passed === true,
    retryCount,
    1000,
  );
  if (aiResult.success) {
    console.log(`[断言通过] 通用AI断言`);
    return;
  }

  throw new Error(
    `断言失败：${JSON.stringify(assertion)}`,
  );
}

// ============================================================
// 数据清理流程 - 通用实现
// ============================================================

/**
 * 点击表格行操作按钮
 * 支持多种 UI 框架的表格结构
 */
async function clickRowActionButton(
  page: Page,
  rowValue: string,
  buttonText: string,
  runner: RunnerContext,
  opts?: {
    tableSelectors?: string[];
    matchMode?: RowMatchMode;
  },
): Promise<boolean> {
  const matchMode = resolveRowMatchMode(opts?.matchMode);
  const tableSelectors = opts?.tableSelectors?.length
    ? opts.tableSelectors
    : DEFAULT_TABLE_ROW_SELECTORS;

  // 策略1：通过表格行定位操作按钮
  for (let i = 0; i < tableSelectors.length; i += 1) {
    const rows = page.locator(tableSelectors[i]);
    const count = await rows.count();
    for (let j = 0; j < count; j += 1) {
      const row = rows.nth(j);
      if (!(await row.isVisible())) {
        continue;
      }
      if (!(await matchRowByCellValue(row, rowValue, matchMode))) {
        continue;
      }

      // 找到目标行，尝试点击操作按钮
      const buttonSelectors = [
        `button:has-text("${buttonText}")`,
        `a:has-text("${buttonText}")`,
        `span:has-text("${buttonText}")`,
        `.el-button:has-text("${buttonText}")`,
        `.ant-btn:has-text("${buttonText}")`,
        `[role="button"]:has-text("${buttonText}")`,
      ];

      for (let k = 0; k < buttonSelectors.length; k += 1) {
        const btn = row.locator(buttonSelectors[k]).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 5000 });
          return true;
        }
      }

      // 尝试通过文本精确匹配
      const byText = row.getByText(buttonText, { exact: true });
      if (await byText.isVisible().catch(() => false)) {
        await byText.click({ timeout: 5000 });
        return true;
      }
    }
  }

  // Playwright 定位失败，使用 AI
  console.log(`[数据清理] Playwright定位失败，使用AI点击行操作按钮"${buttonText}"`);
  await runner.ai(
    `在列表中找到${
      matchMode === 'exact' ? '精确匹配' : '包含匹配'
    }"${rowValue}"的数据行，点击该行的"${buttonText}"按钮`,
  );
  return true;
}

/**
 * 处理确认弹窗
 */
async function handleConfirmDialog(
  task: AcceptanceTask,
  page: Page,
  action: TaskCleanupAction,
  runner: RunnerContext,
): Promise<void> {
  const confirmText = action.confirmButtonText || '确定';
  const dialogTitle = action.confirmDialogTitle;

  // 等待确认弹窗出现
  await page.waitForTimeout(500);

  // 策略1：通过弹窗容器定位确认按钮
  const dialogSelectors = resolveDialogSelectors(task);

  for (let i = 0; i < dialogSelectors.length; i += 1) {
    const dialogs = page.locator(dialogSelectors[i]);
    const count = await dialogs.count();
    for (let j = 0; j < count; j += 1) {
      const dialog = dialogs.nth(j);
      if (!(await dialog.isVisible())) {
        continue;
      }

      // 如果指定了弹窗标题，验证是否匹配
      if (dialogTitle) {
        const dialogText = await dialog.innerText().catch(() => '');
        if (!normalizeText(dialogText).includes(normalizeText(dialogTitle))) {
          continue;
        }
      }

      // 尝试点击确认按钮
      const escaped = escapeRegExp(confirmText);
      const confirmBtn = dialog.getByRole('button', {
        name: new RegExp(`^\\s*${escaped}\\s*$`),
      });
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click({ timeout: 5000 });
        await page.waitForTimeout(500);
        return;
      }

      // 宽松匹配
      const looseBtn = dialog.getByRole('button', {
        name: new RegExp(escaped),
      });
      if (await looseBtn.isVisible().catch(() => false)) {
        await looseBtn.click({ timeout: 5000 });
        await page.waitForTimeout(500);
        return;
      }
    }
  }

  // Playwright 定位失败，使用 AI
  console.log(`[数据清理] Playwright定位失败，使用AI点击确认按钮"${confirmText}"`);
  await runner.ai(`在确认弹窗中点击"${confirmText}"按钮`);
  await page.waitForTimeout(500);
}

/**
 * 等待清理成功提示
 */
async function waitForCleanupSuccess(
  page: Page,
  successText: string,
  timeoutMs: number,
  toastSelectors: string[] = DEFAULT_TOAST_SELECTORS,
): Promise<boolean> {
  const result = await detectTextVisible(
    page,
    successText,
    timeoutMs,
    toastSelectors,
  );
  return result.found;
}

/**
 * 执行单条数据的删除操作
 */
async function executeDeleteAction(
  task: AcceptanceTask,
  cleanup: TaskCleanup,
  targetValue: string,
  action: TaskCleanupAction,
  runner: RunnerContext,
): Promise<{ success: boolean; message: string }> {
  const page = runner.page;
  const buttonText = action.rowButtonText || '删除';
  const rowMatchMode = resolveRowMatchMode(cleanup.rowMatchMode);
  const tableSelectors = resolveTableRowSelectors(task);
  const toastSelectors = resolveToastSelectors(task);
  const verifyAfterCleanup = cleanup.verifyAfterCleanup !== false;

  try {
    // 1. 点击行操作按钮
    console.log(`[数据清理] 点击"${targetValue}"的"${buttonText}"按钮`);
    await clickRowActionButton(page, targetValue, buttonText, runner, {
      tableSelectors,
      matchMode: rowMatchMode,
    });
    await page.waitForTimeout(300);

    // 2. 处理确认弹窗
    if (action.confirmButtonText || action.confirmDialogTitle) {
      console.log(`[数据清理] 处理确认弹窗`);
      await handleConfirmDialog(task, page, action, runner);
    }

    // 3. 等待成功提示
    let successTextDetected = true;
    if (action.successText) {
      successTextDetected = await waitForCleanupSuccess(
        page,
        action.successText,
        8000,
        toastSelectors,
      );
      if (!successTextDetected) {
        console.warn(`[数据清理] 未检测到成功提示"${action.successText}"，但继续执行`);
      }
    }

    if (verifyAfterCleanup) {
      const stillExists = await detectTableRowExists(page, targetValue, 4000, {
        tableSelectors,
        matchMode: rowMatchMode,
      });
      if (stillExists.found) {
        return {
          success: false,
          message: `删除"${targetValue}"后目标行仍存在，疑似未删除成功`,
        };
      }
    } else if (action.successText && !successTextDetected) {
      return {
        success: false,
        message: `删除"${targetValue}"后未检测到成功提示"${action.successText}"`,
      };
    }

    await page.waitForTimeout(500);
    return { success: true, message: `已删除"${targetValue}"` };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, message: `删除"${targetValue}"失败: ${errorMessage}` };
  }
}

/**
 * 执行自定义清理操作
 */
async function executeCustomCleanupAction(
  task: AcceptanceTask,
  targetValue: string,
  action: TaskCleanupAction,
  runner: RunnerContext,
): Promise<{ success: boolean; message: string }> {
  if (!action.customInstruction) {
    return { success: false, message: '自定义清理操作缺少 customInstruction' };
  }

  try {
    // 替换指令中的占位符
    const instruction = action.customInstruction
      .replace(/\{targetValue\}/g, targetValue)
      .replace(/\{value\}/g, targetValue);

    console.log(`[数据清理] 执行自定义操作: ${instruction}`);
    await runner.ai(instruction);
    await runner.page.waitForTimeout(500);

    return { success: true, message: `自定义清理完成: ${targetValue}` };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, message: `自定义清理失败: ${errorMessage}` };
  }
}

/**
 * 搜索定位待清理数据
 */
async function searchForCleanupTarget(
  task: AcceptanceTask,
  cleanup: TaskCleanup,
  targetValue: string,
  runner: RunnerContext,
): Promise<boolean> {
  const page = runner.page;
  const search = task.search;

  if (!search) {
    console.log(`[数据清理] 任务未配置搜索，跳过搜索步骤`);
    return true;
  }

  const inputLabel = search.inputLabel || '关键词';

  // 填写搜索条件
  const filled = await fillTextboxWithLabel(inputLabel, targetValue, runner);
  if (!filled) {
    await runner.ai(`在搜索区字段"${inputLabel}"输入"${targetValue}"`);
  }

  // 触发搜索
  await triggerSearchWithFallback(search.triggerButtonText, runner);

  // 等待列表加载
  await page.waitForTimeout(800);

  // 检查是否找到目标数据
  const result = await detectTableRowExists(page, targetValue, 5000, {
    tableSelectors: resolveTableRowSelectors(task),
    matchMode: resolveRowMatchMode(cleanup.rowMatchMode),
  });
  return result.found;
}

/**
 * 执行数据清理流程
 */
async function runCleanup(
  task: AcceptanceTask,
  resolvedValues: Record<string, string>,
  runner: RunnerContext,
): Promise<{ success: boolean; cleanedCount: number; errors: string[] }> {
  const cleanup = task.cleanup;
  if (!cleanup?.enabled || cleanup.strategy === 'none') {
    console.log(`[数据清理] 清理未启用，跳过`);
    return { success: true, cleanedCount: 0, errors: [] };
  }

  const action = cleanup.action;
  if (!action) {
    console.log(`[数据清理] 未配置清理操作，跳过`);
    return { success: true, cleanedCount: 0, errors: [] };
  }

  const errors: string[] = [];
  let cleanedCount = 0;

  // 确定待清理的目标值
  const matchField = cleanup.matchField || '小区名称';
  const targetValues: string[] = [];

  if (cleanup.strategy === 'delete-created') {
    // 仅删除本次新增的数据
    const createdValue = resolvedValues[matchField];
    if (createdValue) {
      targetValues.push(createdValue);
    }
  } else if (cleanup.strategy === 'delete-all-matched') {
    // 删除所有匹配的数据（需要通过 AI 查询当前列表）
    try {
      const matchedItems = await runner.aiQuery<string[]>(
        `提取当前列表中所有"${matchField}"列的值，返回字符串数组`,
      );
      if (Array.isArray(matchedItems)) {
        targetValues.push(...matchedItems);
      }
    } catch (_error) {
      errors.push('无法获取待清理数据列表');
    }
  } else if (cleanup.strategy === 'custom') {
    // 自定义策略，使用本次新增的数据
    const createdValue = resolvedValues[matchField];
    if (createdValue) {
      targetValues.push(createdValue);
    }
  }

  const normalizedTargetValues = uniqueNonEmpty(targetValues);
  if (normalizedTargetValues.length === 0) {
    console.log(`[数据清理] 无待清理数据`);
    return { success: true, cleanedCount: 0, errors };
  }

  console.log(`[数据清理] 待清理数据: ${normalizedTargetValues.join(', ')}`);

  // 逐条执行清理
  for (let i = 0; i < normalizedTargetValues.length; i += 1) {
    const targetValue = normalizedTargetValues[i];

    // 搜索定位（如果需要）
    if (cleanup.searchBeforeCleanup !== false && task.search) {
      const found = await searchForCleanupTarget(task, cleanup, targetValue, runner);
      if (!found) {
        console.log(`[数据清理] 未找到"${targetValue}"，可能已被删除，跳过`);
        continue;
      }
    }

    // 执行清理操作
    let result: { success: boolean; message: string };
    if (action.actionType === 'delete') {
      result = await executeDeleteAction(
        task,
        cleanup,
        targetValue,
        action,
        runner,
      );
    } else if (action.actionType === 'custom') {
      result = await executeCustomCleanupAction(task, targetValue, action, runner);
    } else {
      result = { success: false, message: `未知操作类型: ${action.actionType}` };
    }

    if (result.success) {
      cleanedCount += 1;
      console.log(`[数据清理] ${result.message}`);
    } else {
      errors.push(result.message);
      console.error(`[数据清理] ${result.message}`);
    }
  }

  const success = cleanup.failOnError !== true || errors.length === 0;
  return { success, cleanedCount, errors };
}

export async function runTaskScenario(
  runner: RunnerContext,
  options?: RunnerOptions,
): Promise<Stage2ExecutionResult> {
  const taskFilePath = resolveTaskFilePath(options?.rawTaskFilePath);
  const rawTaskContent = fs.readFileSync(taskFilePath, 'utf-8');
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
  const persistenceStore = createStage2PersistenceStore({
    task,
    taskFilePath,
    rawTaskContent,
    startedAt,
    runDir,
  });

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
    persistenceStore?.syncProgress({
      status,
      inProgress,
      resolvedValues,
      querySnapshots,
      steps,
      progressFilePath: progressFile,
    });
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
        const shotResult = await captureStepScreenshotSafely(runner.page, shotPath);
        if (shotResult.success) {
          stepResult.screenshotPath = shotPath;
        } else {
          stepResult.message = `步骤截图失败：${shotResult.errorMessage || 'unknown'}`;
        }
      }
    } catch (error) {
      stepResult.status = required ? 'failed' : 'skipped';
      stepResult.message = toErrorMessage(error);
      stepResult.errorStack = toErrorStack(error);
      const shotFileName = `${String(steps.length + 1).padStart(2, '0')}_${sanitizeFileName(stepName)}_failed.png`;
      const shotPath = path.join(screenshotDir, shotFileName);
      const shotResult = await captureStepScreenshotSafely(runner.page, shotPath);
      if (shotResult.success) {
        stepResult.screenshotPath = shotPath;
      } else if (shotResult.errorMessage) {
        stepResult.message = `${stepResult.message}；失败截图保存失败：${shotResult.errorMessage}`;
      }
      const endedOnError = Date.now();
      stepResult.endedAt = new Date(endedOnError).toISOString();
      stepResult.durationMs = endedOnError - stepStartedAt;
      steps.push(stepResult);
      try {
        writeProgress(true, required ? 'failed' : 'passed');
      } catch (_writeError) {
        // ignore
      }
      try {
        persistenceStore?.recordStep({
          stepNo: steps.length,
          stepResult,
        });
      } catch (_recordError) {
        // ignore
      }
      if (required) {
        throw error;
      }
      return;
    }
    const stepEndedAt = Date.now();
    stepResult.endedAt = new Date(stepEndedAt).toISOString();
    stepResult.durationMs = stepEndedAt - stepStartedAt;
    steps.push(stepResult);
    try {
      writeProgress(true, 'passed');
    } catch (_writeError) {
      // ignore
    }
    try {
      persistenceStore?.recordStep({
        stepNo: steps.length,
        stepResult,
      });
    } catch (_recordError) {
      // ignore
    }
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

    await runStep('处理安全验证', async () => {
      await handleCaptchaChallengeIfNeeded(runner);
    });

    if (task.navigation?.homeReadyText) {
      await runStep(
        '等待首页加载',
        async () => {
          const homeText = task.navigation!.homeReadyText!;
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
        const dialogTitle = task.form.dialogTitle!;
        const visible = await waitVisibleByText(
          runner.page,
          dialogTitle,
          stepTimeout || 12000,
        );
        if (!visible) {
          throw new Error(`未检测到弹窗标题：${dialogTitle}`);
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
          const successText = task.form.successText!;
          const toastResult = await detectTextVisible(
            runner.page,
            successText,
            8000,
            resolveToastSelectors(task),
          );
          if (!toastResult.found) {
            throw new Error(`未检测到提交提示：${successText}`);
          }
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
        const isSoft = assertion.soft === true;
        await runStep(
          `业务断言_${assertion.type}_${i + 1}`,
          async () => {
            await runAssertion(assertion, task, resolvedValues, runner);
          },
          { required: !isSoft },
        );
      }
    }

    // 数据清理步骤（在断言完成后执行）
    if (task.cleanup?.enabled && task.cleanup.strategy !== 'none') {
      await runStep(
        '数据清理',
        async () => {
          const cleanupResult = await runCleanup(task, resolvedValues, runner);
          querySnapshots.cleanupResult = cleanupResult;
          if (!cleanupResult.success && task.cleanup?.failOnError) {
            throw new Error(
              `数据清理失败: ${cleanupResult.errors.join('; ')}`,
            );
          }
          console.log(
            `[数据清理] 完成，清理${cleanupResult.cleanedCount}条数据`,
          );
        },
        { required: task.cleanup.failOnError === true },
      );
    }
  } catch (error) {
    finalStatus = 'failed';
    const hasFailedStep = steps.some((item) => item.status === 'failed');
    if (!hasFailedStep) {
      const nowIso = new Date().toISOString();
      const fatalStep: StepResult = {
        name: '系统异常_未归档步骤',
        status: 'failed',
        startedAt: nowIso,
        endedAt: nowIso,
        durationMs: 0,
        message: toErrorMessage(error),
        errorStack: toErrorStack(error),
      };
      const shotFileName = `${String(steps.length + 1).padStart(2, '0')}_fatal_error_failed.png`;
      const shotPath = path.join(screenshotDir, shotFileName);
      const shotResult = await captureStepScreenshotSafely(runner.page, shotPath);
      if (shotResult.success) {
        fatalStep.screenshotPath = shotPath;
      } else if (shotResult.errorMessage) {
        fatalStep.message = `${fatalStep.message}；失败截图保存失败：${shotResult.errorMessage}`;
      }
      steps.push(fatalStep);
      querySnapshots.__fatalError = fatalStep.message;
      try {
        writeProgress(true, 'failed');
      } catch (_writeError) {
        // ignore
      }
      try {
        persistenceStore?.recordStep({
          stepNo: steps.length,
          stepResult: fatalStep,
        });
      } catch (_recordError) {
        // ignore
      }
    } else {
      querySnapshots.__fatalError = toErrorMessage(error);
    }
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
  persistenceStore?.finishRun(result, resultFile);
  persistenceStore?.close();
  return result;
}
