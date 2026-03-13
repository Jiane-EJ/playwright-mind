import { expect } from '@playwright/test';
import { test } from '../fixture/fixture';
import { runStage1Discovery } from '../../src/stage1/stage1-runner';

/**
 * 第一段执行入口（自然语言请求 -> 页面探索 -> 第二段草稿）
 * @author Jiane
 */
test.describe('stage1 discovery runner', () => {
  test.setTimeout(5 * 60 * 1000);

  test('run stage1 discovery from request json', async ({
    page,
    ai,
    aiQuery,
    aiWaitFor,
  }) => {
    const result = await runStage1Discovery({
      page,
      ai,
      aiQuery,
      aiWaitFor,
    });

    if (result.status !== 'passed') {
      const failedStep = [...result.steps].reverse().find((item) => item.status === 'failed');
      const detail = failedStep
        ? `step=${failedStep.name}; message=${failedStep.message || 'unknown'}; screenshot=${failedStep.screenshotPath || 'n/a'}`
        : 'no step detail';
      throw new Error(
        `第一段执行失败: ${detail}; resultFile=${result.runDir}\\stage1-result.json`,
      );
    }
    expect(result.status).toBe('passed');
  });
});
