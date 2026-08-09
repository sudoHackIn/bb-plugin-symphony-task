import type { ExecutionRun, ProjectExecutionPolicy } from "./types.js";

export type WorkState =
  | "queued"
  | "active"
  | "review"
  | "done"
  | "canceled";

export interface WorkItem {
  id: string;
  projectId: string;
  key: string;
  title: string;
  version: string;
}
export interface WorkContext {
  item: WorkItem;
  description: string;
  tracker: "local" | "beads" | "jira";
}

export interface TrackerAdapter {
  readonly kind: "local" | "beads" | "jira";
  listEligible(input: {
    policy: ProjectExecutionPolicy;
    maxAttempts: number;
    limit: number;
  }): Promise<WorkItem[]>;
  getContext(itemId: string): Promise<WorkContext>;
  claim(input: {
    item: WorkItem;
    presetId: string;
    tokenBudget: number | null;
  }): Promise<ExecutionRun | null>;
  renewClaim(runId: string): Promise<void>;
  release(runId: string, reason?: string): Promise<void>;
  attachThread(runId: string, threadId: string): Promise<void>;
  addComment(itemId: string, body: string): Promise<void>;
  transition(itemId: string, state: WorkState): Promise<void>;
}
