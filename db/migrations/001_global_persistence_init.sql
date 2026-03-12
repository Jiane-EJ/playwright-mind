CREATE TABLE ai_task (
  id VARCHAR(64) NOT NULL,
  task_code VARCHAR(128) NOT NULL,
  task_name VARCHAR(255) NOT NULL,
  task_type VARCHAR(64) NOT NULL,
  source_type VARCHAR(64) NOT NULL,
  latest_version_no INT NOT NULL DEFAULT 0,
  latest_source_path VARCHAR(512) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (task_code)
);

CREATE TABLE ai_task_version (
  id VARCHAR(64) NOT NULL,
  task_id VARCHAR(64) NOT NULL,
  version_no INT NOT NULL,
  source_stage VARCHAR(32) NOT NULL,
  source_path VARCHAR(512) NULL,
  content_json TEXT NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (task_id, version_no),
  UNIQUE (task_id, content_hash),
  CONSTRAINT fk_ai_task_version_task_id
    FOREIGN KEY (task_id) REFERENCES ai_task(id)
    ON DELETE CASCADE
);

CREATE TABLE ai_run (
  id VARCHAR(64) NOT NULL,
  run_code VARCHAR(128) NOT NULL,
  stage_code VARCHAR(32) NOT NULL,
  task_id VARCHAR(64) NULL,
  task_version_id VARCHAR(64) NULL,
  status VARCHAR(32) NOT NULL,
  trigger_type VARCHAR(32) NOT NULL,
  trigger_by VARCHAR(128) NULL,
  started_at DATETIME NOT NULL,
  ended_at DATETIME NULL,
  duration_ms BIGINT NOT NULL DEFAULT 0,
  run_dir VARCHAR(512) NULL,
  task_file_path VARCHAR(512) NULL,
  error_message TEXT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (run_code),
  CONSTRAINT fk_ai_run_task_id
    FOREIGN KEY (task_id) REFERENCES ai_task(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_ai_run_task_version_id
    FOREIGN KEY (task_version_id) REFERENCES ai_task_version(id)
    ON DELETE SET NULL
);

CREATE TABLE ai_run_step (
  id VARCHAR(64) NOT NULL,
  run_id VARCHAR(64) NOT NULL,
  step_no INT NOT NULL,
  step_name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  started_at DATETIME NOT NULL,
  ended_at DATETIME NOT NULL,
  duration_ms BIGINT NOT NULL DEFAULT 0,
  message TEXT NULL,
  error_stack TEXT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (run_id, step_no),
  CONSTRAINT fk_ai_run_step_run_id
    FOREIGN KEY (run_id) REFERENCES ai_run(id)
    ON DELETE CASCADE
);

CREATE TABLE ai_snapshot (
  id VARCHAR(64) NOT NULL,
  run_id VARCHAR(64) NOT NULL,
  snapshot_key VARCHAR(128) NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (run_id, snapshot_key),
  CONSTRAINT fk_ai_snapshot_run_id
    FOREIGN KEY (run_id) REFERENCES ai_run(id)
    ON DELETE CASCADE
);

CREATE TABLE ai_artifact (
  id VARCHAR(64) NOT NULL,
  owner_type VARCHAR(32) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  artifact_type VARCHAR(64) NOT NULL,
  artifact_name VARCHAR(255) NOT NULL,
  storage_type VARCHAR(32) NOT NULL,
  relative_path VARCHAR(512) NULL,
  absolute_path VARCHAR(1024) NULL,
  file_size BIGINT NULL,
  file_hash VARCHAR(64) NULL,
  mime_type VARCHAR(128) NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE ai_audit_log (
  id VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  event_code VARCHAR(64) NOT NULL,
  event_detail TEXT NULL,
  operator_name VARCHAR(128) NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX idx_ai_task_name ON ai_task (task_name);
CREATE INDEX idx_ai_run_task_stage_started_at ON ai_run (task_id, stage_code, started_at);
CREATE INDEX idx_ai_run_status_started_at ON ai_run (stage_code, status, started_at);
CREATE INDEX idx_ai_run_step_run_id_status ON ai_run_step (run_id, status);
CREATE INDEX idx_ai_artifact_owner ON ai_artifact (owner_type, owner_id);
CREATE INDEX idx_ai_artifact_type_created_at ON ai_artifact (artifact_type, created_at);
CREATE INDEX idx_ai_audit_log_entity_created_at ON ai_audit_log (entity_type, entity_id, created_at);

