import { test as base } from '@playwright/test';
import type { PlayWrightAiFixtureType } from '@midscene/web/playwright';
import {
  PlaywrightAgent,
  PlaywrightWebPage,
} from '@midscene/web/playwright';
import { setLogDir } from '@midscene/core/utils';
import { midsceneRunDir, resolveRuntimePath } from '../../config/runtime-path';

setLogDir(resolveRuntimePath(midsceneRunDir));

function sanitizeCacheId(input: string): string {
  return input.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

type AiWithOptions = <T = any>(
  prompt: string,
  opts?: { type?: 'action' | 'query' },
) => Promise<T>;

type AiWaitForOpt = Parameters<PlayWrightAiFixtureType['aiWaitFor']>[1];

export const test = base.extend<PlayWrightAiFixtureType>({
  ai: async ({ page }, use, testInfo) => {
    const safeCacheId = sanitizeCacheId(`playwright-${testInfo.testId}`);
    const agent = new PlaywrightAgent(new PlaywrightWebPage(page), {
      testId: `playwright-${safeCacheId}`,
      cacheId: safeCacheId,
      groupName: testInfo.title,
      groupDescription: testInfo.file,
      generateReport: true,
      autoPrintReportMsg: false,
    });
    const aiFn: AiWithOptions = async <T = any>(
      prompt: string,
      opts?: { type?: 'action' | 'query' },
    ) => {
      const actionType = opts?.type || 'action';
      return agent.ai(prompt, actionType) as Promise<T>;
    };
    await use(aiFn);
  },
  aiAction: async ({ page }, use, testInfo) => {
    const safeCacheId = sanitizeCacheId(`playwright-${testInfo.testId}`);
    const agent = new PlaywrightAgent(new PlaywrightWebPage(page), {
      testId: `playwright-${safeCacheId}`,
      cacheId: safeCacheId,
      groupName: testInfo.title,
      groupDescription: testInfo.file,
      generateReport: true,
      autoPrintReportMsg: false,
    });
    await use(async (taskPrompt: string) => {
      return agent.aiAction(taskPrompt);
    });
  },
  aiQuery: async ({ page }, use, testInfo) => {
    const safeCacheId = sanitizeCacheId(`playwright-${testInfo.testId}`);
    const agent = new PlaywrightAgent(new PlaywrightWebPage(page), {
      testId: `playwright-${safeCacheId}`,
      cacheId: safeCacheId,
      groupName: testInfo.title,
      groupDescription: testInfo.file,
      generateReport: true,
      autoPrintReportMsg: false,
    });
    await use(async <T = any>(demand: any) => {
      return agent.aiQuery(demand) as Promise<T>;
    });
  },
  aiAssert: async ({ page }, use, testInfo) => {
    const safeCacheId = sanitizeCacheId(`playwright-${testInfo.testId}`);
    const agent = new PlaywrightAgent(new PlaywrightWebPage(page), {
      testId: `playwright-${safeCacheId}`,
      cacheId: safeCacheId,
      groupName: testInfo.title,
      groupDescription: testInfo.file,
      generateReport: true,
      autoPrintReportMsg: false,
    });
    await use(async (assertion: string, errorMsg?: string) => {
      return agent.aiAssert(assertion, errorMsg);
    });
  },
  aiWaitFor: async ({ page }, use, testInfo) => {
    const safeCacheId = sanitizeCacheId(`playwright-${testInfo.testId}`);
    const agent = new PlaywrightAgent(new PlaywrightWebPage(page), {
      testId: `playwright-${safeCacheId}`,
      cacheId: safeCacheId,
      groupName: testInfo.title,
      groupDescription: testInfo.file,
      generateReport: true,
      autoPrintReportMsg: false,
    });
    await use(async (assertion: string, opt?: AiWaitForOpt) => {
      return agent.aiWaitFor(assertion, opt);
    });
  },
});
