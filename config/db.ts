import path from 'path';
import dotenv from 'dotenv';
import { runtimeDirPrefix } from './runtime-path';

dotenv.config();

const DEFAULT_DB_DRIVER = 'sqlite';
const DEFAULT_DB_FILE_PATH = `${runtimeDirPrefix}db/hi_test.sqlite`;

function readEnv(name: string, fallbackValue: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallbackValue;
}

/**
 * 全局数据库配置
 * 当前落地为 sqlite，本地单文件运行；表结构按 MySQL 兼容子集设计。
 * @author Jiane
 */
export const dbDriver = readEnv('DB_DRIVER', DEFAULT_DB_DRIVER).toLowerCase();

export const dbFilePath = readEnv('DB_FILE_PATH', DEFAULT_DB_FILE_PATH);

export function resolveDbPath(targetPath?: string): string {
  return path.resolve(process.cwd(), targetPath || dbFilePath);
}

