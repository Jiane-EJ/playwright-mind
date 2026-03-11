import { expect } from '@playwright/test';
import { test } from '../fixture/fixture';
import { runTaskScenario } from '../../src/stage2/task-runner';

/**
 * 第二段执行入口（JSON -> Midscene + Playwright 执行）
 * @author Jiane
 */
test.describe('stage2 acceptance runner', () => {
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

    expect(result.status).toBe('passed');
  });
});

