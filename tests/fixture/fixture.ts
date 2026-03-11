import { test as base } from '@playwright/test';
import type { PlayWrightAiFixtureType } from '@midscene/web/playwright';
import { PlaywrightAiFixture } from '@midscene/web/playwright';
import { setLogDir } from '@midscene/core/utils';
import { midsceneRunDir, resolveRuntimePath } from '../../config/runtime-path';

setLogDir(resolveRuntimePath(midsceneRunDir));

export const test = base.extend<PlayWrightAiFixtureType>(PlaywrightAiFixture());
