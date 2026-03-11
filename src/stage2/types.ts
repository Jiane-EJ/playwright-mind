/**
 * 第二段执行模型定义
 * @author Jiane
 */
export interface TaskTarget {
  url: string;
  browser?: string;
  headless?: boolean;
}

export interface TaskAccount {
  username: string;
  password: string;
  loginHints?: string[];
}

export interface TaskNavigation {
  homeReadyText?: string;
  menuPath?: string[];
  menuHints?: string[];
}

export interface TaskField {
  label: string;
  componentType: 'input' | 'textarea' | 'cascader' | string;
  value: string | string[];
  required?: boolean;
  unique?: boolean;
  hints?: string[];
}

export interface TaskForm {
  openButtonText: string;
  dialogTitle?: string;
  submitButtonText: string;
  closeButtonText?: string;
  successText?: string;
  notes?: string[];
  fields: TaskField[];
}

export interface TaskSearch {
  inputLabel: string;
  extraInputLabels?: string[];
  keywordFromField?: string;
  triggerButtonText?: string;
  resetButtonText?: string;
  resultTableTitle?: string;
  notes?: string[];
  expectedColumns?: string[];
  rowActionButtons?: string[];
  pagination?: {
    pageSizeText?: string;
    summaryPattern?: string;
  };
}

export interface TaskAssertion {
  type: string;
  expectedText?: string;
  matchField?: string;
  expectedColumns?: string[];
  column?: string;
  expectedFromField?: string;
}

export interface TaskCleanup {
  enabled?: boolean;
  strategy?: string;
  notes?: string;
}

export interface TaskRuntime {
  stepTimeoutMs?: number;
  pageTimeoutMs?: number;
  screenshotOnStep?: boolean;
  trace?: boolean;
}

export interface TaskApproval {
  approved?: boolean;
  approvedBy?: string;
  approvedAt?: string;
}

export interface AcceptanceTask {
  taskId: string;
  taskName: string;
  target: TaskTarget;
  account: TaskAccount;
  navigation?: TaskNavigation;
  form: TaskForm;
  search?: TaskSearch;
  assertions?: TaskAssertion[];
  cleanup?: TaskCleanup;
  runtime?: TaskRuntime;
  approval?: TaskApproval;
}

export interface StepResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  screenshotPath?: string;
  message?: string;
  errorStack?: string;
}

export interface Stage2ExecutionResult {
  taskId: string;
  taskName: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'passed' | 'failed';
  taskFilePath: string;
  runDir: string;
  resolvedValues: Record<string, string>;
  querySnapshots: Record<string, unknown>;
  steps: StepResult[];
}

