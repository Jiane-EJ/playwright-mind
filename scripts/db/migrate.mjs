import {
  checksum,
  ensureMigrationTable,
  getDbRuntimeOptions,
  hasAppliedMigration,
  listMigrationFiles,
  loadMigrationSql,
  openDatabase,
  recordMigration,
} from './common.mjs';

const runtimeOptions = getDbRuntimeOptions();
const database = openDatabase();

try {
  ensureMigrationTable(database);
  const migrationFiles = listMigrationFiles();

  if (migrationFiles.length === 0) {
    console.log('[db:migrate] 未找到 migration 文件，跳过');
  } else {
    console.log(`[db:migrate] driver=${runtimeOptions.dbDriver}`);
    console.log(`[db:migrate] file=${runtimeOptions.resolvedDbFilePath}`);

    for (let i = 0; i < migrationFiles.length; i += 1) {
      const fileName = migrationFiles[i];
      if (hasAppliedMigration(database, fileName)) {
        console.log(`[db:migrate] 已存在，跳过: ${fileName}`);
        continue;
      }

      const sql = loadMigrationSql(fileName);
      const fileChecksum = checksum(sql);

      database.exec('BEGIN');
      try {
        database.exec(sql);
        recordMigration(database, fileName, fileChecksum);
        database.exec('COMMIT');
        console.log(`[db:migrate] 已执行: ${fileName}`);
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  }

  console.log('[db:migrate] 完成');
} finally {
  database.close();
}
