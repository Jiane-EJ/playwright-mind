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

export interface TaskUiProfile {
  /** 表格行选择器，跨平台可按优先级补充 */
  tableRowSelectors?: string[];
  /** Toast/消息选择器，跨平台可按优先级补充 */
  toastSelectors?: string[];
  /** 弹窗容器选择器，跨平台可按优先级补充 */
  dialogSelectors?: string[];
}

export interface TaskAssertion {
  type: string;
  expectedText?: string;
  matchField?: string;
  expectedColumns?: string[];
  /** 列名 -> 字段名映射，用于将表格列与表单字段对齐 */
  expectedColumnFromFields?: Record<string, string>;
  /** 列名 -> 期望值映射，优先级高于 expectedColumnFromFields */
  expectedColumnValues?: Record<string, string>;
  column?: string;
  expectedFromField?: string;
  /** 行匹配模式，默认 exact */
  matchMode?: 'exact' | 'contains';
  /** 断言超时时间（毫秒），默认 15000 */
  timeoutMs?: number;
  /** 断言重试次数，默认 2 */
  retryCount?: number;
  /** 是否为软断言（失败不中断流程），默认 false */
  soft?: boolean;
  /** 自定义断言描述（用于 AI 断言） */
  description?: string;
}

export interface TaskCleanupAction {
  /** 操作类型：delete=删除, custom=自定义AI指令 */
  actionType: 'delete' | 'custom';
  /** 行操作按钮文案，如"删除" */
  rowButtonText?: string;
  /** 确认弹窗标题 */
  confirmDialogTitle?: string;
  /** 确认按钮文案 */
  confirmButtonText?: string;
  /** 取消按钮文案 */
  cancelButtonText?: string;
  /** 成功提示文案 */
  successText?: string;
  /** 自定义 AI 指令（actionType=custom 时使用） */
  customInstruction?: string;
  /** 操作提示/辅助信息 */
  hints?: string[];
}

export interface TaskCleanup {
  enabled?: boolean;
  /** 清理策略：delete-created=删除本次新增数据, delete-all-matched=删除所有匹配数据, custom=自定义 */
  strategy?: 'delete-created' | 'delete-all-matched' | 'custom' | 'none';
  /** 用于定位待删除数据的字段（通常与表单中的 unique 字段对应） */
  matchField?: string;
  /** 清理操作配置 */
  action?: TaskCleanupAction;
  /** 清理前是否需要先搜索定位数据 */
  searchBeforeCleanup?: boolean;
  /** 行匹配模式，默认 exact，contains 仅在业务明确允许时使用 */
  rowMatchMode?: 'exact' | 'contains';
  /** 删除后是否校验目标行已消失，默认 true */
  verifyAfterCleanup?: boolean;
  /** 清理失败是否中断任务 */
  failOnError?: boolean;
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
  uiProfile?: TaskUiProfile;
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
