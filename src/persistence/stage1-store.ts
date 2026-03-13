import fs from 'fs';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Stage1DiscoveryResult,
  Stage1Request,
  Stage1StepResult,
  Stage1StructuredSnapshot,
} from '../stage1/types';
import {
  applyPendingMigrations,
  createPersistentId,
  formatDbDate,
  openPersistenceDatabase,
  sha256Hex,
  toRelativeProjectPath,
} from './sqlite-runtime';

type Stage1StoreInitOptions = {
  request: Stage1Request;
  requestFilePath: string;
  rawRequestContent: string;
  startedAt: string;
  runDir: string;
};

type Stage1ProgressPayload = {
  status: 'passed' | 'failed';
  inProgress: boolean;
  structuredSnapshot: Stage1StructuredSnapshot;
  steps: Stage1StepResult[];
  progressFilePath: string;
};

type Stage1StepPayload = {
  stepNo: number;
  stepResult: Stage1StepResult;
};

type Stage1RunArtifacts = {
  homeScreenshotPath?: string;
  summaryFilePath?: string;
  structuredSnapshotFilePath?: string;
  mappingReportFilePath?: string;
  draftTaskFilePath?: string;
  reviewNotesFilePath?: string;
};

function maskSensitiveRequestContent(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as Record<string, unknown>;
    const account = parsed.account as Record<string, unknown> | undefined;
    if (account?.password) {
      account.password = '******';
    }
    return JSON.stringify(parsed, null, 2);
  } catch (_error) {
    return rawContent;
  }
}

function normalizeTextContent(input: unknown): string {
  return JSON.stringify(input ?? {}, null, 2);
}

function normalizeAbsolutePath(targetPath?: string): string | undefined {
  if (!targetPath) {
    return undefined;
  }
  return path.resolve(targetPath);
}

function getFileStat(targetPath?: string): { fileSize?: number } {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return {};
  }
  const stat = fs.statSync(targetPath);
  return { fileSize: stat.size };
}

/**
 * Stage1 写库服务
 * 使用 sqlite 落本地库，同时保持表结构与 MySQL 迁移方向兼容。
 * @author Jiane
 */
export class Stage1PersistenceStore {
  private readonly database: DatabaseSync;

  private readonly request: Stage1Request;

  private readonly requestFilePath: string;

  private readonly rawRequestContent: string;

  private readonly persistedRequestContent: string;

  private readonly startedAt: string;

  private readonly runDir: string;

  private readonly taskRecordId: string;

  private readonly taskVersionId: string;

  private readonly runRecordId: string;

  private readonly runCode: string;

  private readonly stepIdByNo = new Map<number, string>();

  private closed = false;

  constructor(options: Stage1StoreInitOptions) {
    this.request = options.request;
    this.requestFilePath = options.requestFilePath;
    this.rawRequestContent = options.rawRequestContent;
    this.persistedRequestContent = maskSensitiveRequestContent(options.rawRequestContent);
    this.startedAt = options.startedAt;
    this.runDir = options.runDir;
    this.database = openPersistenceDatabase();
    applyPendingMigrations(this.database);
    this.taskRecordId = this.ensureTaskRecord();
    this.taskVersionId = this.ensureTaskVersionRecord();
    this.runRecordId = createPersistentId('run');
    this.runCode = `stage1_${this.request.requestId}_${Date.now()}`;
    this.insertRunRecord();
    this.upsertArtifact({
      ownerType: 'task_version',
      ownerId: this.taskVersionId,
      artifactType: 'task_json',
      artifactName: path.basename(this.requestFilePath),
      filePath: this.requestFilePath,
    });
    this.insertAuditLog('ai_run', this.runRecordId, 'RUN_STARTED', `第一段开始执行：${this.request.requestId}`);
  }

  private safeExecute(actionName: string, executor: () => void): void {
    try {
      executor();
    } catch (error) {
      console.error(
        `[Stage1持久化] ${actionName}失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private ensureTaskRecord(): string {
    const selectStatement = this.database.prepare(`
      SELECT id
      FROM ai_task
      WHERE task_code = ?
    `);
    const existing = selectStatement.get(this.request.requestId) as { id?: string } | undefined;
    const now = formatDbDate();
    if (existing?.id) {
      const updateStatement = this.database.prepare(`
        UPDATE ai_task
        SET task_name = ?, latest_source_path = ?, updated_at = ?
        WHERE id = ?
      `);
      updateStatement.run(
        this.request.requestName,
        toRelativeProjectPath(this.requestFilePath) || this.requestFilePath,
        now,
        existing.id,
      );
      return existing.id;
    }

    const taskId = createPersistentId('task');
    const insertStatement = this.database.prepare(`
      INSERT INTO ai_task (
        id,
        task_code,
        task_name,
        task_type,
        source_type,
        latest_version_no,
        latest_source_path,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStatement.run(
      taskId,
      this.request.requestId,
      this.request.requestName,
      'discovery_request',
      'json_file',
      0,
      toRelativeProjectPath(this.requestFilePath) || this.requestFilePath,
      now,
      now,
    );
    this.insertAuditLog('ai_task', taskId, 'TASK_CREATED', `创建第一段任务：${this.request.requestId}`);
    return taskId;
  }

  private ensureTaskVersionRecord(): string {
    const contentHash = sha256Hex(this.rawRequestContent);
    const selectStatement = this.database.prepare(`
      SELECT id, version_no
      FROM ai_task_version
      WHERE task_id = ? AND content_hash = ?
    `);
    const existing = selectStatement.get(this.taskRecordId, contentHash) as
      | { id?: string; version_no?: number }
      | undefined;
    const now = formatDbDate();
    if (existing?.id) {
      const updateTaskStatement = this.database.prepare(`
        UPDATE ai_task
        SET latest_version_no = ?, latest_source_path = ?, updated_at = ?
        WHERE id = ?
      `);
      updateTaskStatement.run(
        existing.version_no || 1,
        toRelativeProjectPath(this.requestFilePath) || this.requestFilePath,
        now,
        this.taskRecordId,
      );
      return existing.id;
    }

    const maxStatement = this.database.prepare(`
      SELECT MAX(version_no) AS max_version_no
      FROM ai_task_version
      WHERE task_id = ?
    `);
    const maxRow = maxStatement.get(this.taskRecordId) as { max_version_no?: number } | undefined;
    const versionNo = (maxRow?.max_version_no || 0) + 1;
    const versionId = createPersistentId('task_ver');
    const insertStatement = this.database.prepare(`
      INSERT INTO ai_task_version (
        id,
        task_id,
        version_no,
        source_stage,
        source_path,
        content_json,
        content_hash,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStatement.run(
      versionId,
      this.taskRecordId,
      versionNo,
      'stage1',
      toRelativeProjectPath(this.requestFilePath) || this.requestFilePath,
      this.persistedRequestContent,
      contentHash,
      now,
    );
    const updateTaskStatement = this.database.prepare(`
      UPDATE ai_task
      SET latest_version_no = ?, latest_source_path = ?, updated_at = ?
      WHERE id = ?
    `);
    updateTaskStatement.run(
      versionNo,
      toRelativeProjectPath(this.requestFilePath) || this.requestFilePath,
      now,
      this.taskRecordId,
    );
    this.insertAuditLog(
      'ai_task_version',
      versionId,
      'TASK_VERSION_CREATED',
      `创建第一段任务版本：${this.request.requestId}#${versionNo}`,
    );
    return versionId;
  }

  private insertRunRecord(): void {
    const now = formatDbDate();
    const insertStatement = this.database.prepare(`
      INSERT INTO ai_run (
        id,
        run_code,
        stage_code,
        task_id,
        task_version_id,
        status,
        trigger_type,
        trigger_by,
        started_at,
        ended_at,
        duration_ms,
        run_dir,
        task_file_path,
        error_message,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStatement.run(
      this.runRecordId,
      this.runCode,
      'stage1',
      this.taskRecordId,
      this.taskVersionId,
      'running',
      'manual',
      'stage1-runner',
      formatDbDate(this.startedAt),
      null,
      0,
      toRelativeProjectPath(this.runDir) || this.runDir,
      toRelativeProjectPath(this.requestFilePath) || this.requestFilePath,
      null,
      now,
      now,
    );
  }

  private insertAuditLog(
    entityType: string,
    entityId: string,
    eventCode: string,
    eventDetail?: string,
  ): void {
    const insertStatement = this.database.prepare(`
      INSERT INTO ai_audit_log (
        id,
        entity_type,
        entity_id,
        event_code,
        event_detail,
        operator_name,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertStatement.run(
      createPersistentId('audit'),
      entityType,
      entityId,
      eventCode,
      eventDetail || null,
      'stage1-runner',
      formatDbDate(),
    );
  }

  private updateRunRecord(params: {
    status?: string;
    endedAt?: string;
    durationMs?: number;
    errorMessage?: string;
  }): void {
    const updateStatement = this.database.prepare(`
      UPDATE ai_run
      SET status = ?,
          ended_at = ?,
          duration_ms = ?,
          error_message = ?,
          updated_at = ?
      WHERE id = ?
    `);
    updateStatement.run(
      params.status || 'running',
      params.endedAt ? formatDbDate(params.endedAt) : null,
      params.durationMs || 0,
      params.errorMessage || null,
      formatDbDate(),
      this.runRecordId,
    );
  }

  private upsertSnapshot(snapshotKey: string, snapshotValue: unknown): void {
    const selectStatement = this.database.prepare(`
      SELECT id
      FROM ai_snapshot
      WHERE run_id = ? AND snapshot_key = ?
    `);
    const existing = selectStatement.get(this.runRecordId, snapshotKey) as { id?: string } | undefined;
    const snapshotJson = normalizeTextContent(snapshotValue);
    const now = formatDbDate();
    if (existing?.id) {
      const updateStatement = this.database.prepare(`
        UPDATE ai_snapshot
        SET snapshot_json = ?, updated_at = ?
        WHERE id = ?
      `);
      updateStatement.run(snapshotJson, now, existing.id);
      return;
    }

    const insertStatement = this.database.prepare(`
      INSERT INTO ai_snapshot (
        id,
        run_id,
        snapshot_key,
        snapshot_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertStatement.run(
      createPersistentId('snapshot'),
      this.runRecordId,
      snapshotKey,
      snapshotJson,
      now,
      now,
    );
  }

  private upsertArtifact(params: {
    ownerType: 'task' | 'task_version' | 'run' | 'run_step';
    ownerId: string;
    artifactType: 'task_json' | 'result_json' | 'progress_json' | 'screenshot' | 'playwright_report' | 'midscene_report' | 'other';
    artifactName: string;
    filePath?: string;
    mimeType?: string;
  }): void {
    const absolutePath = normalizeAbsolutePath(params.filePath);
    const relativePath = toRelativeProjectPath(absolutePath);
    const fileStat = getFileStat(absolutePath);
    const selectStatement = this.database.prepare(`
      SELECT id
      FROM ai_artifact
      WHERE owner_type = ? AND owner_id = ? AND artifact_type = ? AND artifact_name = ?
    `);
    const existing = selectStatement.get(
      params.ownerType,
      params.ownerId,
      params.artifactType,
      params.artifactName,
    ) as { id?: string } | undefined;
    if (existing?.id) {
      const updateStatement = this.database.prepare(`
        UPDATE ai_artifact
        SET relative_path = ?,
            absolute_path = ?,
            file_size = ?,
            mime_type = ?
        WHERE id = ?
      `);
      updateStatement.run(
        relativePath || null,
        absolutePath || null,
        fileStat.fileSize || null,
        params.mimeType || null,
        existing.id,
      );
      return;
    }

    const insertStatement = this.database.prepare(`
      INSERT INTO ai_artifact (
        id,
        owner_type,
        owner_id,
        artifact_type,
        artifact_name,
        storage_type,
        relative_path,
        absolute_path,
        file_size,
        file_hash,
        mime_type,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStatement.run(
      createPersistentId('artifact'),
      params.ownerType,
      params.ownerId,
      params.artifactType,
      params.artifactName,
      'local_file',
      relativePath || null,
      absolutePath || null,
      fileStat.fileSize || null,
      null,
      params.mimeType || null,
      formatDbDate(),
    );
  }

  syncProgress(payload: Stage1ProgressPayload): void {
    if (this.closed) {
      return;
    }
    this.safeExecute('同步进度快照', () => {
      this.upsertSnapshot('structured_snapshot', payload.structuredSnapshot);
      this.upsertSnapshot('progress_state', {
        status: payload.status,
        inProgress: payload.inProgress,
        stepCount: payload.steps.length,
        lastStepName: payload.steps[payload.steps.length - 1]?.name,
        updatedAt: new Date().toISOString(),
      });
      this.upsertArtifact({
        ownerType: 'run',
        ownerId: this.runRecordId,
        artifactType: 'progress_json',
        artifactName: path.basename(payload.progressFilePath),
        filePath: payload.progressFilePath,
        mimeType: 'application/json',
      });
    });
  }

  recordStep(payload: Stage1StepPayload): void {
    if (this.closed) {
      return;
    }
    this.safeExecute(`写入步骤_${payload.stepNo}`, () => {
      const now = formatDbDate();
      const existingStepId = this.stepIdByNo.get(payload.stepNo);
      if (existingStepId) {
        const updateStatement = this.database.prepare(`
          UPDATE ai_run_step
          SET step_name = ?,
              status = ?,
              started_at = ?,
              ended_at = ?,
              duration_ms = ?,
              message = ?,
              error_stack = ?,
              updated_at = ?
          WHERE id = ?
        `);
        updateStatement.run(
          payload.stepResult.name,
          payload.stepResult.status,
          formatDbDate(payload.stepResult.startedAt),
          formatDbDate(payload.stepResult.endedAt),
          payload.stepResult.durationMs,
          payload.stepResult.message || null,
          payload.stepResult.errorStack || null,
          now,
          existingStepId,
        );
        if (payload.stepResult.screenshotPath) {
          this.upsertArtifact({
            ownerType: 'run_step',
            ownerId: existingStepId,
            artifactType: 'screenshot',
            artifactName: path.basename(payload.stepResult.screenshotPath),
            filePath: payload.stepResult.screenshotPath,
            mimeType: 'image/png',
          });
        }
        return;
      }

      const stepId = createPersistentId('run_step');
      this.stepIdByNo.set(payload.stepNo, stepId);
      const insertStatement = this.database.prepare(`
        INSERT INTO ai_run_step (
          id,
          run_id,
          step_no,
          step_name,
          status,
          started_at,
          ended_at,
          duration_ms,
          message,
          error_stack,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertStatement.run(
        stepId,
        this.runRecordId,
        payload.stepNo,
        payload.stepResult.name,
        payload.stepResult.status,
        formatDbDate(payload.stepResult.startedAt),
        formatDbDate(payload.stepResult.endedAt),
        payload.stepResult.durationMs,
        payload.stepResult.message || null,
        payload.stepResult.errorStack || null,
        now,
        now,
      );
      if (payload.stepResult.screenshotPath) {
        this.upsertArtifact({
          ownerType: 'run_step',
          ownerId: stepId,
          artifactType: 'screenshot',
          artifactName: path.basename(payload.stepResult.screenshotPath),
          filePath: payload.stepResult.screenshotPath,
          mimeType: 'image/png',
        });
      }
      if (payload.stepResult.status === 'failed') {
        this.insertAuditLog(
          'ai_run_step',
          stepId,
          'STEP_FAILED',
          `${payload.stepResult.name}: ${payload.stepResult.message || 'unknown'}`,
        );
      }
    });
  }

  finishRun(
    result: Stage1DiscoveryResult,
    resultFilePath: string,
    artifacts?: Stage1RunArtifacts,
  ): void {
    if (this.closed) {
      return;
    }
    this.safeExecute('写入最终结果', () => {
      const failedStep = [...result.steps].reverse().find((item) => item.status === 'failed');
      this.updateRunRecord({
        status: result.status,
        endedAt: result.endedAt,
        durationMs: result.durationMs,
        errorMessage: failedStep?.message,
      });
      this.upsertSnapshot('structured_snapshot', result.structuredSnapshot);
      this.upsertSnapshot('final_result_summary', {
        requestId: result.requestId,
        requestName: result.requestName,
        status: result.status,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        durationMs: result.durationMs,
        stepCount: result.steps.length,
      });
      this.upsertArtifact({
        ownerType: 'run',
        ownerId: this.runRecordId,
        artifactType: 'result_json',
        artifactName: path.basename(resultFilePath),
        filePath: resultFilePath,
        mimeType: 'application/json',
      });
      if (artifacts?.homeScreenshotPath) {
        this.upsertArtifact({
          ownerType: 'run',
          ownerId: this.runRecordId,
          artifactType: 'screenshot',
          artifactName: path.basename(artifacts.homeScreenshotPath),
          filePath: artifacts.homeScreenshotPath,
          mimeType: 'image/png',
        });
      }
      if (artifacts?.summaryFilePath) {
        this.upsertArtifact({
          ownerType: 'run',
          ownerId: this.runRecordId,
          artifactType: 'other',
          artifactName: path.basename(artifacts.summaryFilePath),
          filePath: artifacts.summaryFilePath,
          mimeType: 'application/json',
        });
      }
      if (artifacts?.structuredSnapshotFilePath) {
        this.upsertArtifact({
          ownerType: 'run',
          ownerId: this.runRecordId,
          artifactType: 'other',
          artifactName: path.basename(artifacts.structuredSnapshotFilePath),
          filePath: artifacts.structuredSnapshotFilePath,
          mimeType: 'application/json',
        });
      }
      if (artifacts?.mappingReportFilePath) {
        this.upsertArtifact({
          ownerType: 'run',
          ownerId: this.runRecordId,
          artifactType: 'other',
          artifactName: path.basename(artifacts.mappingReportFilePath),
          filePath: artifacts.mappingReportFilePath,
          mimeType: 'application/json',
        });
      }
      if (artifacts?.draftTaskFilePath) {
        this.upsertArtifact({
          ownerType: 'run',
          ownerId: this.runRecordId,
          artifactType: 'task_json',
          artifactName: path.basename(artifacts.draftTaskFilePath),
          filePath: artifacts.draftTaskFilePath,
          mimeType: 'application/json',
        });
      }
      if (artifacts?.reviewNotesFilePath) {
        this.upsertArtifact({
          ownerType: 'run',
          ownerId: this.runRecordId,
          artifactType: 'other',
          artifactName: path.basename(artifacts.reviewNotesFilePath),
          filePath: artifacts.reviewNotesFilePath,
          mimeType: 'text/markdown',
        });
      }
      this.insertAuditLog(
        'ai_run',
        this.runRecordId,
        'RUN_FINISHED',
        `第一段执行结束：${result.requestId} -> ${result.status}`,
      );
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.safeExecute('关闭数据库连接', () => {
      this.database.close();
      this.closed = true;
    });
  }
}

export function createStage1PersistenceStore(
  options: Stage1StoreInitOptions,
): Stage1PersistenceStore | null {
  try {
    return new Stage1PersistenceStore(options);
  } catch (error) {
    console.error(
      `[Stage1持久化] 初始化失败: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
