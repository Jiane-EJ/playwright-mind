import fs from 'fs';
import path from 'path';
import type { Page } from '@playwright/test';
import type { PlayWrightAiFixtureType } from '@midscene/web/playwright';
import { resolveRuntimePath, stage1ResultDir } from '../../config/runtime-path';
import { createStage1PersistenceStore } from '../persistence/stage1-store';
import { collectStage1StructuredSnapshot } from './explorer';
import { loadStage1Request, resolveStage1RequestFilePath } from './request-loader';
import { generateStage2DraftTask } from './task-draft-generator';
import type {
  Stage1DiscoveryResult,
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
