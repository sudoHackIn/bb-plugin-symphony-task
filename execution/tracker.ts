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
  labels: string[];
}
export interface WorkContext {
  item: WorkItem;
  description: string;
  tracker: "local" | "beads" | "jira";
  state: WorkState;
  recentComments: Array<{
    author: string;
    body: string;
    createdAt: string;
  }>;
}

export interface ReleaseClaimInput {
  resetToQueued: boolean;
  reason?: string;
}

export interface AddCommentInput {
  kind: "agent" | "system";
  threadId?: string;
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
  release(runId: string, input: ReleaseClaimInput): Promise<void>;
  attachThread(runId: string, threadId: string): Promise<void>;
  addComment(
    itemId: string,
    body: string,
    input: AddCommentInput,
  ): Promise<void>;
  transition(itemId: string, state: WorkState): Promise<void>;
}
