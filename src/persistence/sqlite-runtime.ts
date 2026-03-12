import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { dbDriver, resolveDbPath } from '../../config/db';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'db', 'migrations');

function checksum(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function formatDbDate(input?: string | number | Date): string {
  const date = input ? new Date(input) : new Date();
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export function createPersistentId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

export function sha256Hex(content: string): string {
  return checksum(content);
}

export function toRelativeProjectPath(targetPath?: string): string | undefined {
  if (!targetPath) {
    return undefined;
  }
  const relativePath = path.relative(process.cwd(), targetPath);
  if (!relativePath || relativePath.startsWith('..')) {
    return undefined;
  }
  return relativePath.replace(/\\/g, '/');
}

function ensureMigrationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name VARCHAR(255) NOT NULL,
      migration_checksum VARCHAR(64) NOT NULL,
      executed_at DATETIME NOT NULL,
      PRIMARY KEY (migration_name)
    )
  `);
}

function loadMigrationFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();
}

function hasAppliedMigration(database: DatabaseSync, fileName: string): boolean {
  const statement = database.prepare(`
    SELECT migration_name
    FROM schema_migrations
    WHERE migration_name = ?
  `);
  return Boolean(statement.get(fileName));
}

export function openPersistenceDatabase(): DatabaseSync {
  if (dbDriver !== 'sqlite') {
    throw new Error(`当前仅支持 sqlite 持久化驱动，实际配置: ${dbDriver}`);
  }
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new DatabaseSync(dbPath, {
    enableForeignKeyConstraints: true,
  });
  database.exec('PRAGMA foreign_keys = ON;');
  return database;
}

export function applyPendingMigrations(database: DatabaseSync): void {
  ensureMigrationTable(database);
  const migrationFiles = loadMigrationFiles();
  for (let i = 0; i < migrationFiles.length; i += 1) {
    const fileName = migrationFiles[i];
    if (hasAppliedMigration(database, fileName)) {
      continue;
    }
    const sqlFilePath = path.join(MIGRATIONS_DIR, fileName);
    const sql = fs.readFileSync(sqlFilePath, 'utf8');
    const fileChecksum = checksum(sql);
    const insertStatement = database.prepare(`
      INSERT INTO schema_migrations (
        migration_name,
        migration_checksum,
        executed_at
      ) VALUES (?, ?, ?)
    `);
    database.exec('BEGIN');
    try {
      database.exec(sql);
      insertStatement.run(fileName, fileChecksum, formatDbDate());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

