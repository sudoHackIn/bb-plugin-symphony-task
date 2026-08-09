export const EXECUTION_PROJECT_MODES = ["off", "opt_in", "all_todo"] as const;
export type ExecutionProjectMode = (typeof EXECUTION_PROJECT_MODES)[number];

export const TASK_EXECUTION_POLICIES = [
  "inherit",
  "enabled",
  "disabled",
] as const;
export type TaskExecutionPolicy = (typeof TASK_EXECUTION_POLICIES)[number];

export const EXECUTION_RUN_STATUSES = [
  "claimed",
  "starting",
  "running",
  "waiting_review",
  "completed",
  "failed",
  "budget_exhausted",
  "canceled",
  "released",
] as const;
export type ExecutionRunStatus = (typeof EXECUTION_RUN_STATUSES)[number];

export interface ExecutionConfig {
  enabled: boolean;
  maxWorkers: number;
  pollIntervalSeconds: number;
  defaultTokenBudget: number | null;
  maxAttempts: number;
  updatedAt: string;
}
export interface ProjectExecutionPolicy {
  projectId: string;
  mode: ExecutionProjectMode;
  presetId: string | null;
  maxWorkers: number | null;
  tokenBudget: number | null;
  updatedAt: string;
}

export interface TaskExecutionPolicyRecord {
  tracker: "local" | "beads" | "jira";
  projectId: string;
  workItemId: string;
  policy: TaskExecutionPolicy;
  updatedAt: string;
}

export interface ExecutionRun {
  id: string;
  tracker: "local" | "beads" | "jira";
  projectId: string;
  workItemId: string;
  taskKey: string;
  taskTitle: string;
  externalVersion: string;
  threadId: string | null;
  claimId: string;
  claimExpiresAt: string | null;
  status: ExecutionRunStatus;
  attempt: number;
  presetId: string | null;
  tokenBudget: number | null;
  tokensUsed: number;
  lastEventSeq: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface EligibleWorkItem {
  id: string;
  projectId: string;
  key: string;
  title: string;
  version: string;
  policy: TaskExecutionPolicy;
  latestStatus: ExecutionRunStatus | null;
  latestAttempt: number | null;
}
