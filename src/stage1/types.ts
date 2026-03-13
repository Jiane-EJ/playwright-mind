/**
 * 第一段探索建模类型定义
 * @author Jiane
 */
export interface Stage1Target {
  url: string;
  browser?: string;
  headless?: boolean;
}

export interface Stage1Account {
  username: string;
  password: string;
  loginHints?: string[];
}

export interface Stage1Goal {
  scenarioDescription: string;
  expectedOutcome?: string;
}

export interface Stage1Scope {
  menuPathHints?: string[];
  mustExploreAreas?: string[];
  skipAreas?: string[];
}

export interface Stage1Review {
  required?: boolean;
  reviewer?: string;
}

export interface Stage1Runtime {
  stepTimeoutMs?: number;
  pageTimeoutMs?: number;
  screenshotOnStep?: boolean;
}

export interface Stage1Request {
  requestId: string;
  requestName: string;
  target: Stage1Target;
  account: Stage1Account;
  goal: Stage1Goal;
  scope?: Stage1Scope;
  review?: Stage1Review;
  runtime?: Stage1Runtime;
}

export interface Stage1StepResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  screenshotPath?: string;
  message?: string;
  errorStack?: string;
}

export interface Stage1Evidence {
  homeScreenshotPath?: string;
  summaryFilePath?: string;
  structuredSnapshotFilePath?: string;
  mappingReportFilePath?: string;
  reviewNotesFilePath?: string;
}

export interface Stage1FieldCandidate {
  label: string;
  placeholder?: string;
  required?: boolean;
}

export interface Stage1StructuredSnapshot {
  pageTitle: string;
  currentUrl: string;
  menuCandidates: string[];
  openButtonCandidates: string[];
  submitButtonCandidates: string[];
  closeButtonCandidates: string[];
  searchTriggerCandidates: string[];
  resetButtonCandidates: string[];
  dialogTitleCandidates: string[];
  rowActionButtonCandidates: string[];
  successTextCandidates: string[];
  formFieldCandidates: Stage1FieldCandidate[];
  searchFieldCandidates: string[];
  tableColumnCandidates: string[];
  visibleTexts: string[];
  notes: string[];
  uncertainties: string[];
}

export interface Stage1DiscoveryResult {
  requestId: string;
  requestName: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'passed' | 'failed';
  requestFilePath: string;
  runDir: string;
  draftTaskFilePath: string;
  evidence: Stage1Evidence;
  structuredSnapshot: Stage1StructuredSnapshot;
  steps: Stage1StepResult[];
}
