/**
 * 全局数据持久化模型定义
 * 第一阶段和第二阶段共用该组基础类型。
 * @author Jiane
 */

export type PersistentStageCode = 'stage1' | 'stage2';

export type PersistentTaskSourceType = 'json_file' | 'stage1_export' | 'manual';

export type PersistentRunStatus =
  | 'draft'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type PersistentOwnerType =
  | 'task'
  | 'task_version'
  | 'run'
  | 'run_step';

export type PersistentArtifactType =
  | 'task_json'
  | 'result_json'
  | 'progress_json'
  | 'screenshot'
  | 'playwright_report'
  | 'midscene_report'
  | 'other';

export interface PersistentTaskRecord {
  id: string;
  taskCode: string;
  taskName: string;
  taskType: string;
  sourceType: PersistentTaskSourceType;
  latestVersionNo: number;
  latestSourcePath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersistentTaskVersionRecord {
  id: string;
  taskId: string;
  versionNo: number;
  sourceStage: PersistentStageCode;
  sourcePath?: string;
  contentJson: string;
  contentHash: string;
  createdAt: string;
}

export interface PersistentRunRecord {
  id: string;
  runCode: string;
  stageCode: PersistentStageCode;
  taskId?: string;
  taskVersionId?: string;
  status: PersistentRunStatus;
  triggerType: string;
  triggerBy?: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  runDir?: string;
  taskFilePath?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersistentRunStepRecord {
  id: string;
  runId: string;
  stepNo: number;
  stepName: string;
  status: PersistentRunStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  message?: string;
  errorStack?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersistentSnapshotRecord {
  id: string;
  runId: string;
  snapshotKey: string;
  snapshotJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersistentArtifactRecord {
  id: string;
  ownerType: PersistentOwnerType;
  ownerId: string;
  artifactType: PersistentArtifactType;
  artifactName: string;
  storageType: 'local_file';
  relativePath?: string;
  absolutePath?: string;
  fileSize?: number;
  fileHash?: string;
  mimeType?: string;
  createdAt: string;
}

export interface PersistentAuditLogRecord {
  id: string;
  entityType: string;
  entityId: string;
  eventCode: string;
  eventDetail?: string;
  operatorName?: string;
  createdAt: string;
}

