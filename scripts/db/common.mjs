import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { DatabaseSync } from 'node:sqlite';

dotenv.config();

const DEFAULT_RUNTIME_DIR_PREFIX = 't_runtime/';
const DEFAULT_DB_DRIVER = 'sqlite';

function readEnv(name, fallbackValue) {
  const value = process.env[name]?.trim();
  return value ? value : fallbackValue;
}

export function formatSqlDate(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export function checksum(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function getDbRuntimeOptions() {
  const runtimeDirPrefix = readEnv('RUNTIME_DIR_PREFIX', DEFAULT_RUNTIME_DIR_PREFIX);
  const dbDriver = readEnv('DB_DRIVER', DEFAULT_DB_DRIVER).toLowerCase();
  const dbFilePath = readEnv('DB_FILE_PATH', `${runtimeDirPrefix}db/hi_test.sqlite`);
  return {
    dbDriver,
    dbFilePath,
    resolvedDbFilePath: path.resolve(process.cwd(), dbFilePath),
    migrationsDir: path.resolve(process.cwd(), 'db', 'migrations'),
  };
}

function ensureDir(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
}

export function openDatabase() {
  const options = getDbRuntimeOptions();
  if (options.dbDriver !== 'sqlite') {
    throw new Error(`当前 db 脚本仅支持 sqlite，实际驱动: ${options.dbDriver}`);
  }
  ensureDir(path.dirname(options.resolvedDbFilePath));
  const database = new DatabaseSync(options.resolvedDbFilePath, {
    enableForeignKeyConstraints: true,
  });
  database.exec('PRAGMA foreign_keys = ON;');
  return database;
}

export function ensureMigrationTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name VARCHAR(255) NOT NULL,
      migration_checksum VARCHAR(64) NOT NULL,
      executed_at DATETIME NOT NULL,
      PRIMARY KEY (migration_name)
    )
  `);
}

export function listMigrationFiles() {
  const options = getDbRuntimeOptions();
  if (!fs.existsSync(options.migrationsDir)) {
    return [];
  }
  return fs
    .readdirSync(options.migrationsDir)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();
}

export function loadMigrationSql(fileName) {
  const options = getDbRuntimeOptions();
  const fullPath = path.join(options.migrationsDir, fileName);
  return fs.readFileSync(fullPath, 'utf8');
}

export function hasAppliedMigration(database, fileName) {
  const statement = database.prepare(`
    SELECT migration_name
    FROM schema_migrations
    WHERE migration_name = ?
  `);
  return Boolean(statement.get(fileName));
}

export function recordMigration(database, fileName, fileChecksum) {
  const statement = database.prepare(`
    INSERT INTO schema_migrations (
      migration_name,
      migration_checksum,
      executed_at
    ) VALUES (?, ?, ?)
  `);
  statement.run(fileName, fileChecksum, formatSqlDate());
}

