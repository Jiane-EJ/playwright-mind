import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_RUNTIME_DIR_PREFIX = 't_';

function readEnv(name: string, fallbackValue: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallbackValue;
}

export const runtimeDirPrefix = readEnv(
  'RUNTIME_DIR_PREFIX',
  DEFAULT_RUNTIME_DIR_PREFIX,
);

export const playwrightOutputDir = readEnv(
  'PLAYWRIGHT_OUTPUT_DIR',
  `${runtimeDirPrefix}test-results`,
);

export const playwrightHtmlReportDir = readEnv(
  'PLAYWRIGHT_HTML_REPORT_DIR',
  `${runtimeDirPrefix}playwright-report`,
);

export const midsceneRunDir = readEnv(
  'MIDSCENE_RUN_DIR',
  `${runtimeDirPrefix}midscene_run`,
);

export function resolveRuntimePath(targetDir: string): string {
  return path.resolve(process.cwd(), targetDir);
}
