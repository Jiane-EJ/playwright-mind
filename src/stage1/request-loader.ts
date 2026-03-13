import fs from 'fs';
import path from 'path';
import type { Stage1Request } from './types';

const DEFAULT_REQUEST_FILE = 'specs/stage1/stage1-request.community-create.example.json';
const NOW_TOKEN = 'NOW_YYYYMMDDHHMMSS';

function formatNow(): string {
  const date = new Date();
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}`;
}

function resolveTemplateString(input: string, nowValue: string): string {
  return input.replace(/\$\{([^}]+)\}/g, (_match, token: string) => {
    const trimmedToken = token.trim();
    if (trimmedToken === NOW_TOKEN) {
      return nowValue;
    }
    const envValue = process.env[trimmedToken];
    if (!envValue) {
      return '';
    }
    return envValue;
  });
}

function resolveTemplates<T>(input: T, nowValue: string): T {
  if (typeof input === 'string') {
    return resolveTemplateString(input, nowValue) as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => resolveTemplates(item, nowValue)) as T;
  }
  if (input && typeof input === 'object') {
    const result: Record<string, unknown> = {};
    Object.entries(input as Record<string, unknown>).forEach(([key, value]) => {
      result[key] = resolveTemplates(value, nowValue);
    });
    return result as T;
  }
  return input;
}

function assertRequestShape(
  request: Partial<Stage1Request>,
  requestFilePath: string,
): asserts request is Stage1Request {
  if (!request.requestId) {
    throw new Error(`第一段请求缺少 requestId: ${requestFilePath}`);
  }
  if (!request.requestName) {
    throw new Error(`第一段请求缺少 requestName: ${requestFilePath}`);
  }
  if (!request.target?.url) {
    throw new Error(`第一段请求缺少 target.url: ${requestFilePath}`);
  }
  if (!request.account?.username || !request.account.password) {
    throw new Error(`第一段请求缺少 account.username 或 account.password: ${requestFilePath}`);
  }
  if (!request.goal?.scenarioDescription) {
    throw new Error(`第一段请求缺少 goal.scenarioDescription: ${requestFilePath}`);
  }
}

export function resolveStage1RequestFilePath(rawRequestFilePath?: string): string {
  const requestFilePath = rawRequestFilePath || process.env.STAGE1_REQUEST_FILE || DEFAULT_REQUEST_FILE;
  if (path.isAbsolute(requestFilePath)) {
    return requestFilePath;
  }
  return path.resolve(process.cwd(), requestFilePath);
}

export function loadStage1Request(requestFilePath: string): Stage1Request {
  if (!fs.existsSync(requestFilePath)) {
    throw new Error(`第一段请求文件不存在: ${requestFilePath}`);
  }
  const content = fs.readFileSync(requestFilePath, 'utf-8');
  const rawRequest = JSON.parse(content) as Partial<Stage1Request>;
  assertRequestShape(rawRequest, requestFilePath);
  const nowValue = formatNow();
  return resolveTemplates<Stage1Request>(rawRequest, nowValue);
}
