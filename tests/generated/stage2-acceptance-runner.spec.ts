import { expect } from '@playwright/test';
import { test } from '../fixture/fixture';
import { runTaskScenario } from '../../src/stage2/task-runner';

/**
 * 第二段执行入口（JSON -> Midscene + Playwright 执行）
 * @author Jiane
 */
test.describe('stage2 acceptance runner', () => {
  test.setTimeout(5 * 60 * 1000);

  test('run acceptance task from json', async ({
    page,
    ai,
    aiAssert,
    aiQuery,
    aiWaitFor,
  }) => {
    const result = await runTaskScenario({
      page,
      ai,
      aiAssert,
      aiQuery,
      aiWaitFor,
    });

    if (result.status !== 'passed') {
      const failedStep = [...result.steps].reverse().find((item) => item.status === 'failed');
      const detail = failedStep
        ? `step=${failedStep.name}; message=${failedStep.message || 'unknown'}; screenshot=${failedStep.screenshotPath || 'n/a'}`
        : 'no step detail';
      throw new Error(
        `第二段执行失败: ${detail}; resultFile=${result.runDir}\\result.json`,
      );
    }
    expect(result.status).toBe('passed');
  });
});
