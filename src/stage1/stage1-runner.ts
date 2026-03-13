import fs from 'fs';
import path from 'path';
import type { Frame, Locator, Page } from '@playwright/test';
import type { PlayWrightAiFixtureType } from '@midscene/web/playwright';
import { resolveRuntimePath, stage1ResultDir } from '../../config/runtime-path';
import { createStage1PersistenceStore } from '../persistence/stage1-store';
import { collectStage1StructuredSnapshot } from './explorer';
import { loadStage1Request, resolveStage1RequestFilePath } from './request-loader';
import { generateStage2DraftTask } from './task-draft-generator';
import type {
  Stage1DiscoveryResult,
  Stage1Request,
  Stage1StructuredSnapshot,
  Stage1StepResult,
} from './types';

type AiContext = Pick<PlayWrightAiFixtureType, 'ai' | 'aiQuery' | 'aiWaitFor'>;

type RunnerContext = AiContext & {
  page: Page;
};

type RunnerOptions = {
  rawRequestFilePath?: string;
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
  'iframe[src*="captcha"]',
  'iframe[src*="nocaptcha"]',
  'iframe[id*="captcha"]',
  'iframe[id*="nc_"]',
];

type CaptchaMode =
  | typeof CAPTCHA_MODE_MANUAL
  | typeof CAPTCHA_MODE_AUTO
  | typeof CAPTCHA_MODE_FAIL
  | typeof CAPTCHA_MODE_IGNORE;

type SliderPosition = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function resolveStage1CaptchaMode(): CaptchaMode {
  const value = (
    process.env.STAGE1_CAPTCHA_MODE
    || process.env.STAGE2_CAPTCHA_MODE
    || DEFAULT_CAPTCHA_MODE
  )
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

function resolveStage1CaptchaWaitTimeoutMs(): number {
  const rawValue = process.env.STAGE1_CAPTCHA_WAIT_TIMEOUT_MS
    || process.env.STAGE2_CAPTCHA_WAIT_TIMEOUT_MS;
  if (!rawValue) {
    return DEFAULT_CAPTCHA_WAIT_TIMEOUT_MS;
  }
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_CAPTCHA_WAIT_TIMEOUT_MS;
  }
  return Math.floor(parsedValue);
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

function createEmptyStructuredSnapshot(): Stage1StructuredSnapshot {
  return {
    pageTitle: '',
    currentUrl: '',
    menuCandidates: [],
    openButtonCandidates: [],
    submitButtonCandidates: [],
    closeButtonCandidates: [],
    searchTriggerCandidates: [],
    resetButtonCandidates: [],
    dialogTitleCandidates: [],
    rowActionButtonCandidates: [],
    successTextCandidates: [],
    formFieldCandidates: [],
    searchFieldCandidates: [],
    tableColumnCandidates: [],
    visibleTexts: [],
    notes: [],
    uncertainties: [],
  };
}

function createRunDir(requestId: string): {
  runDir: string;
  screenshotDir: string;
  evidenceDir: string;
} {
  const baseResultDir = resolveRuntimePath(stage1ResultDir);
  const runDir = path.join(baseResultDir, sanitizeFileName(requestId), nowStamp());
  const screenshotDir = path.join(runDir, 'screenshots');
  const evidenceDir = path.join(runDir, 'evidence');
  fs.mkdirSync(screenshotDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  return { runDir, screenshotDir, evidenceDir };
}

function withPageTimeout(runtimeTimeoutMs: number | undefined): {
  timeout: number;
} | undefined {
  if (!runtimeTimeoutMs || runtimeTimeoutMs <= 0) {
    return undefined;
  }
  return { timeout: runtimeTimeoutMs };
}

function writeJsonFile(targetPath: string, payload: unknown): void {
  fs.writeFileSync(targetPath, JSON.stringify(payload, null, 2), 'utf-8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

async function clickFirstVisible(locator: Locator): Promise<boolean> {
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

async function clickMenuWithFallback(
  menuName: string,
  runner: RunnerContext,
): Promise<void> {
  const escaped = escapeRegExp(menuName);
  const page = runner.page;
  const clicked = await clickFirstVisible(
    page.locator('.el-menu-item, .el-submenu__title, .ant-menu-item, .ant-menu-submenu-title')
      .filter({ hasText: menuName }),
  ) || await clickFirstVisible(
    page.getByRole('menuitem', { name: new RegExp(escaped) }),
  ) || await clickFirstVisible(
    page.getByRole('link', { name: new RegExp(escaped) }),
  ) || await clickFirstVisible(
    page.getByText(menuName, { exact: false }),
  );

  if (!clicked) {
    await runner.ai(`在当前页面点击菜单“${menuName}”`);
  }
  await page.waitForTimeout(800);
}

function shouldOpenCreateEntryForExploration(request: Stage1Request): boolean {
  const description = request.goal?.scenarioDescription || '';
  return /新增|新建|添加|录入/.test(description);
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

async function isLoginFormStillVisible(page: Page): Promise<boolean> {
  const passwordVisible = await isLocatorVisible(
    page.locator('input[type="password"], input[placeholder*="密码"]'),
  );
  const accountVisible = await isLocatorVisible(
    page.locator(
      'input[placeholder*="账号"], input[placeholder*="用户名"], input[placeholder*="登录名"]',
    ),
  );
  const loginButtonVisible = await isLocatorVisible(
    page.locator(
      'button:has-text("登录"), .el-button:has-text("登录"), .ant-btn:has-text("登录"), [type="submit"]',
    ),
  );
  return passwordVisible && (accountVisible || loginButtonVisible);
}

async function detectCaptchaChallenge(page: Page): Promise<boolean> {
  const detectInFrame = async (frame: Frame): Promise<boolean> => {
    for (let i = 0; i < CAPTCHA_TEXT_PATTERNS.length; i += 1) {
      const pattern = CAPTCHA_TEXT_PATTERNS[i];
      if (
        await isLocatorVisible(
          frame.getByText(pattern, { exact: false }).first(),
        )
      ) {
        return true;
      }
    }
    for (let i = 0; i < CAPTCHA_SELECTOR_PATTERNS.length; i += 1) {
      const selector = CAPTCHA_SELECTOR_PATTERNS[i];
      if (await isLocatorVisible(frame.locator(selector))) {
        return true;
      }
    }
    return false;
  };

  if (await detectInFrame(page.mainFrame())) {
    return true;
  }
  const frames = page.frames();
  for (let i = 0; i < frames.length; i += 1) {
    if (frames[i] === page.mainFrame()) {
      continue;
    }
    if (await detectInFrame(frames[i])) {
      return true;
    }
  }
  return false;
}

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
    // ignore
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
    // ignore
  }
  return null;
}

async function autoSolveSliderCaptcha(runner: RunnerContext): Promise<boolean> {
  const sliderPos = await querySliderPosition(runner);
  if (!sliderPos) {
    return false;
  }
  const trackWidth = await querySliderTrackWidth(runner);
  const targetX = trackWidth ? sliderPos.x + trackWidth - 50 : sliderPos.x + 250;
  const page = runner.page;

  try {
    await page.waitForTimeout(500);
    await page.mouse.move(sliderPos.x, sliderPos.y);
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.waitForTimeout(300);

    const totalDistance = targetX - sliderPos.x;
    const steps = 15;
    for (let i = 1; i <= steps; i += 1) {
      const progress = i / steps;
      const easeOut = 1 - Math.pow(1 - progress, 2);
      const targetStepX = sliderPos.x + totalDistance * easeOut;
      const jitterX = (Math.random() - 0.5) * 6;
      const jitterY = (Math.random() - 0.5) * 4;
      const currentX = Math.round(targetStepX + jitterX);
      const currentY = Math.round(sliderPos.y + jitterY);
      await page.mouse.move(currentX, currentY);
      await page.waitForTimeout(30 + Math.random() * 50);
    }

    await page.mouse.move(targetX, sliderPos.y);
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(500);
    await page.waitForTimeout(2000);

    const stillFound = await detectCaptchaChallenge(page);
    if (!stillFound) {
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(500);
      return true;
    }
    return false;
  } catch (_error) {
    try {
      await page.mouse.up();
    } catch (_innerError) {
      // ignore
    }
    return false;
  }
}

async function handleCaptchaChallengeIfNeeded(
  runner: RunnerContext,
): Promise<void> {
  const mode = resolveStage1CaptchaMode();
  if (mode === CAPTCHA_MODE_IGNORE) {
    return;
  }
  let found = await detectCaptchaChallenge(runner.page);
  if (!found) {
    const detectDeadline = Date.now() + 5000;
    while (Date.now() < detectDeadline) {
      await runner.page.waitForTimeout(500);
      found = await detectCaptchaChallenge(runner.page);
      if (found) {
        break;
      }
    }
  }
  if (!found) {
    return;
  }
  if (mode === CAPTCHA_MODE_FAIL) {
    throw new Error(
      '检测到滑块/安全验证，当前配置为 fail，不允许继续执行。',
    );
  }
  if (mode === CAPTCHA_MODE_AUTO) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const solved = await autoSolveSliderCaptcha(runner);
      if (solved) {
        return;
      }
      if (attempt < maxAttempts) {
        await runner.page.waitForTimeout(2000);
      }
    }
    throw new Error(
      `滑块自动处理失败，已尝试${maxAttempts}次。建议改为 manual 模式人工处理。`,
    );
  }

  const timeoutMs = resolveStage1CaptchaWaitTimeoutMs();
  const deadline = Date.now() + timeoutMs;
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
    `滑块/安全验证在 ${timeoutMs}ms 内未处理完成，可调整 STAGE1_CAPTCHA_WAIT_TIMEOUT_MS。`,
  );
}

/**
 * 第一段探索建模最小执行器
 * 输出：stage1-result.json / stage1-result.partial.json / draft.acceptance-task.json
 * @author Jiane
 */
export async function runStage1Discovery(
  runner: RunnerContext,
  options?: RunnerOptions,
): Promise<Stage1DiscoveryResult> {
  const requestFilePath = resolveStage1RequestFilePath(options?.rawRequestFilePath);
  const request = loadStage1Request(requestFilePath);
  const rawRequestContent = fs.readFileSync(requestFilePath, 'utf-8');

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const stepTimeout = request.runtime?.stepTimeoutMs || 12000;
  const { runDir, screenshotDir, evidenceDir } = createRunDir(request.requestId);
  const steps: Stage1StepResult[] = [];
  const screenshotOnStep = request.runtime?.screenshotOnStep !== false;
  const resultFile = path.join(runDir, 'stage1-result.json');
  const progressFile = path.join(runDir, 'stage1-result.partial.json');
  const summaryFilePath = path.join(evidenceDir, 'exploration-summary.json');
  const structuredSnapshotFilePath = path.join(evidenceDir, 'structured-snapshot.json');
  const mappingReportFilePath = path.join(evidenceDir, 'mapping-report.json');
  const homeScreenshotPath = path.join(evidenceDir, 'home-page.png');
  const draftTaskFilePath = path.join(runDir, 'draft.acceptance-task.json');
  const reviewNotesFilePath = path.join(runDir, 'review-notes.md');
  const persistenceStore = createStage1PersistenceStore({
    request,
    requestFilePath,
    rawRequestContent,
    startedAt,
    runDir,
  });
  let structuredSnapshot = createEmptyStructuredSnapshot();

  const writeProgress = (
    inProgress: boolean,
    status: 'passed' | 'failed',
  ): void => {
    const now = Date.now();
    writeJsonFile(progressFile, {
      requestId: request.requestId,
      requestName: request.requestName,
      startedAt,
      endedAt: new Date(now).toISOString(),
      durationMs: now - started,
      status,
      inProgress,
      requestFilePath,
      runDir,
      draftTaskFilePath,
      evidence: {
        homeScreenshotPath: fs.existsSync(homeScreenshotPath)
          ? homeScreenshotPath
          : undefined,
        summaryFilePath: fs.existsSync(summaryFilePath) ? summaryFilePath : undefined,
        structuredSnapshotFilePath: fs.existsSync(structuredSnapshotFilePath)
          ? structuredSnapshotFilePath
          : undefined,
        mappingReportFilePath: fs.existsSync(mappingReportFilePath)
          ? mappingReportFilePath
          : undefined,
        reviewNotesFilePath: fs.existsSync(reviewNotesFilePath)
          ? reviewNotesFilePath
          : undefined,
      },
      structuredSnapshot,
      steps,
    });
    persistenceStore?.syncProgress({
      status,
      inProgress,
      structuredSnapshot,
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
    const stepResult: Stage1StepResult = {
      name: stepName,
      status: 'passed',
      startedAt: new Date(stepStartedAt).toISOString(),
      endedAt: new Date(stepStartedAt).toISOString(),
      durationMs: 0,
    };
    try {
      await handler();
      if (screenshotOnStep) {
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
      persistenceStore?.recordStep({ stepNo: steps.length, stepResult });
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
    persistenceStore?.recordStep({ stepNo: steps.length, stepResult });
    writeProgress(true, 'passed');
  };

  let finalStatus: 'passed' | 'failed' = 'passed';
  try {
    await runStep('打开系统首页', async () => {
      await runner.page.goto(request.target.url, withPageTimeout(request.runtime?.pageTimeoutMs));
    });

    await runStep('执行登录并进入探索态', async () => {
      const hints = (request.account.loginHints || []).join('；');
      await runner.ai(
        `请在登录页完成登录：账号输入“${request.account.username}”，密码输入“${request.account.password}”，点击登录。该步骤用于第一段探索建模。${hints}`,
      );
    });

    await runStep('处理登录安全验证', async () => {
      const loginUrlBeforeCaptcha = runner.page.url();
      await handleCaptchaChallengeIfNeeded(runner);
      const captchaStillFound = await detectCaptchaChallenge(runner.page);
      if (captchaStillFound) {
        throw new Error('安全验证处理后仍检测到验证码弹窗');
      }
      const loginFormStillVisible = await isLoginFormStillVisible(runner.page);
      const loginUrlUnchanged = runner.page.url() === loginUrlBeforeCaptcha;
      if (loginFormStillVisible && loginUrlUnchanged) {
        throw new Error('安全验证弹窗已关闭，但页面仍停留在登录态，疑似未通过验证码');
      }
    });

    const menuPathHints = request.scope?.menuPathHints || [];
    for (let i = 0; i < menuPathHints.length; i += 1) {
      const menuName = menuPathHints[i];
      await runStep(
        `导航菜单_${menuName}`,
        async () => {
          await clickMenuWithFallback(menuName, runner);
        },
        { required: false },
      );
    }

    await runStep(
      '尝试打开新增入口用于探索',
      async () => {
        if (!shouldOpenCreateEntryForExploration(request)) {
          return;
        }
        await runner.ai(
          '在当前页面尝试点击“新增”或“添加”入口，仅用于探索元素；如果出现弹窗，请保持弹窗打开，不要提交。',
        );
      },
      { required: false },
    );

    await runStep(
      '等待页面进入可探索状态',
      async () => {
        const keywords = request.scope?.mustExploreAreas || [];
        if (keywords.length === 0) {
          await runner.page.waitForLoadState('domcontentloaded');
          return;
        }
        for (let i = 0; i < keywords.length; i += 1) {
          const found = await waitVisibleByText(runner.page, keywords[i], stepTimeout);
          if (found) {
            return;
          }
        }
        throw new Error('未检测到任何待探索区域关键字');
      },
      { required: false },
    );

    await runStep('采集首页证据截图', async () => {
      await runner.page.screenshot({ path: homeScreenshotPath, fullPage: true });
    });

    await runStep(
      '采集结构化探索摘要',
      async () => {
        structuredSnapshot = await collectStage1StructuredSnapshot(runner.page);
        writeJsonFile(structuredSnapshotFilePath, structuredSnapshot);
        writeJsonFile(summaryFilePath, {
          pageTitle: structuredSnapshot.pageTitle,
          currentUrl: structuredSnapshot.currentUrl,
          menuCandidates: structuredSnapshot.menuCandidates.slice(0, 10),
          openButtonCandidates: structuredSnapshot.openButtonCandidates.slice(0, 10),
          submitButtonCandidates: structuredSnapshot.submitButtonCandidates.slice(0, 10),
          dialogTitleCandidates: structuredSnapshot.dialogTitleCandidates.slice(0, 10),
          searchTriggerCandidates: structuredSnapshot.searchTriggerCandidates.slice(0, 10),
          rowActionButtonCandidates: structuredSnapshot.rowActionButtonCandidates.slice(0, 10),
          tableColumnCandidates: structuredSnapshot.tableColumnCandidates.slice(0, 15),
          formFieldCandidates: structuredSnapshot.formFieldCandidates.slice(0, 15),
          uncertainties: structuredSnapshot.uncertainties,
        });
      },
      { required: false },
    );

    await runStep('生成第二段任务草稿', async () => {
      const draftBuildResult = generateStage2DraftTask(request, structuredSnapshot);
      writeJsonFile(draftTaskFilePath, draftBuildResult.draftTask);
      writeJsonFile(mappingReportFilePath, draftBuildResult.mappingReport);
    });

    await runStep('生成人工复核说明', async () => {
      const reviewNotes = [
        '# 第一段人工复核说明',
        '',
        `- requestId: ${request.requestId}`,
        `- requestName: ${request.requestName}`,
        `- draftTask: ${draftTaskFilePath}`,
        '',
        '## 复核重点',
        '',
        '- 请确认 menuPath、openButtonText、dialogTitle、submitButtonText',
        '- 请补齐 form.fields 的真实字段定义',
        '- 请补齐 assertions 与 cleanup 策略',
        `- 参考字段映射报告：${mappingReportFilePath}`,
        '- 请优先处理以下不确定项：',
        ...structuredSnapshot.uncertainties.map((item) => `  - ${item}`),
        '- 确认无误后再交由第二段执行',
        '',
        '@author Jiane',
      ].join('\n');
      fs.writeFileSync(reviewNotesFilePath, reviewNotes, 'utf-8');
    });
  } catch (_error) {
    finalStatus = 'failed';
  }

  const ended = Date.now();
  const result: Stage1DiscoveryResult = {
    requestId: request.requestId,
    requestName: request.requestName,
    startedAt,
    endedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
    status: finalStatus,
    requestFilePath,
    runDir,
    draftTaskFilePath,
    evidence: {
      homeScreenshotPath: fs.existsSync(homeScreenshotPath)
        ? homeScreenshotPath
        : undefined,
      summaryFilePath: fs.existsSync(summaryFilePath) ? summaryFilePath : undefined,
      structuredSnapshotFilePath: fs.existsSync(structuredSnapshotFilePath)
        ? structuredSnapshotFilePath
        : undefined,
      mappingReportFilePath: fs.existsSync(mappingReportFilePath)
        ? mappingReportFilePath
        : undefined,
      reviewNotesFilePath: fs.existsSync(reviewNotesFilePath)
        ? reviewNotesFilePath
        : undefined,
    },
    structuredSnapshot,
    steps,
  };

  try {
    writeJsonFile(resultFile, result);
    writeProgress(false, finalStatus);
    persistenceStore?.finishRun(result, resultFile, {
      homeScreenshotPath: result.evidence.homeScreenshotPath,
      summaryFilePath: result.evidence.summaryFilePath,
      structuredSnapshotFilePath: result.evidence.structuredSnapshotFilePath,
      mappingReportFilePath: result.evidence.mappingReportFilePath,
      draftTaskFilePath: fs.existsSync(draftTaskFilePath) ? draftTaskFilePath : undefined,
      reviewNotesFilePath: result.evidence.reviewNotesFilePath,
    });
    return result;
  } finally {
    persistenceStore?.close();
  }
}
