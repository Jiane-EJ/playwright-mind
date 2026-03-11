import fs from 'fs';
import path from 'path';
import type { AcceptanceTask } from './types';

const DEFAULT_TASK_FILE = 'specs/tasks/acceptance-task.community-create.example.json';
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

function assertTaskShape(task: Partial<AcceptanceTask>, taskFilePath: string): asserts task is AcceptanceTask {
  if (!task.taskId) {
    throw new Error(`任务文件缺少 taskId: ${taskFilePath}`);
  }
  if (!task.taskName) {
    throw new Error(`任务文件缺少 taskName: ${taskFilePath}`);
  }
  if (!task.target?.url) {
    throw new Error(`任务文件缺少 target.url: ${taskFilePath}`);
  }
  if (!task.account?.username || !task.account.password) {
    throw new Error(`任务文件缺少 account.username 或 account.password: ${taskFilePath}`);
  }
  if (!task.form?.openButtonText || !task.form.submitButtonText) {
    throw new Error(`任务文件缺少 form.openButtonText 或 form.submitButtonText: ${taskFilePath}`);
  }
  if (!task.form.fields || task.form.fields.length === 0) {
    throw new Error(`任务文件缺少 form.fields: ${taskFilePath}`);
  }
}

export function resolveTaskFilePath(rawTaskFilePath?: string): string {
  const taskFilePath = rawTaskFilePath || process.env.STAGE2_TASK_FILE || DEFAULT_TASK_FILE;
  if (path.isAbsolute(taskFilePath)) {
    return taskFilePath;
  }
  return path.resolve(process.cwd(), taskFilePath);
}

export function loadTask(taskFilePath: string): AcceptanceTask {
  if (!fs.existsSync(taskFilePath)) {
    throw new Error(`任务文件不存在: ${taskFilePath}`);
  }
  const content = fs.readFileSync(taskFilePath, 'utf-8');
  const rawTask = JSON.parse(content) as Partial<AcceptanceTask>;
  assertTaskShape(rawTask, taskFilePath);
  const nowValue = formatNow();
  const resolvedTask = resolveTemplates<AcceptanceTask>(rawTask, nowValue);
  return resolvedTask;
}

