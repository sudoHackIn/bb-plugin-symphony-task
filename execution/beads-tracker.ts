import { randomUUID } from "node:crypto";
import { BeadsTaskSource } from "../lib/beads-source.js";
import type { TaskStatus } from "../lib/task-source.js";
import type { ExecutionStore } from "./store.js";
import type { ExecutionRun } from "./types.js";
import type {
  AddCommentInput,
  ReleaseClaimInput,
  TrackerAdapter,
  WorkContext,
  WorkItem,
  WorkState,
} from "./tracker.js";
import { matchesProjectEligibility } from "./eligibility.js";

const LEASE_SECONDS = 120;
const ACTIVE_RUN_STATUSES = new Set(["claimed", "starting", "running"]);

function leaseExpiry(): string {
  return new Date(Date.now() + LEASE_SECONDS * 1_000).toISOString();
}

function workState(status: TaskStatus): WorkState {
  switch (status) {
    case "in_progress":
      return "active";
    case "in_review":
      return "review";
    case "done":
      return "done";
    default:
      return "queued";
  }
}

function taskStatus(state: WorkState): TaskStatus {
  switch (state) {
    case "active":
      return "in_progress";
    case "review":
      return "in_review";
    case "done":
    case "canceled":
      return "done";
    case "queued":
      return "backlog";
  }
}

function requireRun(
  executions: ExecutionStore,
  runId: string,
): ExecutionRun {
  const run = executions.getRun(runId);
  if (!run) throw new Error(`Execution run not found: ${runId}`);
  if (run.tracker !== "beads") {
    throw new Error(`Execution run ${runId} does not belong to Beads`);
  }
  return run;
}

export class BeadsTrackerAdapter implements TrackerAdapter {
  readonly kind = "beads" as const;

  constructor(
    private readonly projectId: string,
    private readonly source: BeadsTaskSource,
    private readonly executions: ExecutionStore,
    private readonly owner: string,
  ) {}

  async listEligible(
    input: Parameters<TrackerAdapter["listEligible"]>[0],
  ): Promise<WorkItem[]> {
    if (input.policy.mode === "off") return [];
    const activeClaimIds = new Set(
      this.executions
        .listActiveRuns()
        .filter(
          (run) =>
            run.tracker === this.kind && run.projectId === this.projectId,
        )
        .map((run) => run.claimId),
    );
    await this.source.recoverOwnedClaims(this.owner, activeClaimIds);
    const ready = await this.source.listReady();
    return ready
      .filter((task) => {
        const policy =
          this.executions.getTaskPolicy("beads", this.projectId, task.id)
            ?.policy ?? "inherit";
        if (!matchesProjectEligibility(task.labels, policy, input.policy))
          return false;
        const latest = this.executions.getLatestRun(
          "beads",
          this.projectId,
          task.id,
        );
        if (latest && ACTIVE_RUN_STATUSES.has(latest.status)) return false;
        if (latest?.status === "budget_exhausted") return false;
        if (
          latest?.status === "failed" &&
          latest.attempt >= input.maxAttempts
        ) {
          return false;
        }
        return true;
      })
      .slice(0, input.limit)
      .map((task) => ({
        id: task.id,
        projectId: this.projectId,
        key: task.key,
        title: task.title,
        version: task.updatedAt,
        labels: task.labels,
      }));
  }

  async getContext(itemId: string): Promise<WorkContext> {
    const [task, comments] = await Promise.all([
      this.source.get(itemId),
      this.source.listComments(itemId),
    ]);
    return {
      item: {
        id: task.id,
        projectId: this.projectId,
        key: task.key,
        title: task.title,
        version: task.updatedAt,
        labels: task.labels,
      },
      description: task.description,
      tracker: this.kind,
      state: workState(task.status),
      recentComments: comments.slice(-5).map((comment) => ({
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt,
      })),
    };
  }

  async claim(input: {
    item: WorkItem;
    presetId: string;
    tokenBudget: number | null;
  }): Promise<ExecutionRun | null> {
    const current = this.executions.getLatestRun(
      this.kind,
      this.projectId,
      input.item.id,
    );
    if (current && ACTIVE_RUN_STATUSES.has(current.status)) return null;

    const claimId = randomUUID();
    const expiresAt = leaseExpiry();
    const claimed = await this.source.claim({
      issueId: input.item.id,
      owner: this.owner,
      claimId,
      expiresAt,
    });
    if (!claimed) return null;

    try {
      const run = this.executions.claimExternal({
        tracker: this.kind,
        item: {
          ...input.item,
          version: claimed.updatedAt,
          policy:
            this.executions.getTaskPolicy(
              this.kind,
              this.projectId,
              input.item.id,
            )?.policy ?? "inherit",
          latestStatus: current?.status ?? null,
          latestAttempt: current?.attempt ?? null,
        },
        claimId,
        claimExpiresAt: expiresAt,
        presetId: input.presetId,
        tokenBudget: input.tokenBudget,
      });
      if (run) return run;
      await this.source.releaseClaim({
        issueId: input.item.id,
        owner: this.owner,
        claimId,
        expiresAt,
        resetToQueued: true,
      });
      return null;
    } catch (error) {
      await this.source
        .releaseClaim({
          issueId: input.item.id,
          owner: this.owner,
          claimId,
          expiresAt,
          resetToQueued: true,
        })
        .catch(() => {});
      throw error;
    }
  }

  async renewClaim(runId: string): Promise<void> {
    const run = requireRun(this.executions, runId);
    const expiresAt = leaseExpiry();
    const renewed = await this.source.renewClaim({
      issueId: run.workItemId,
      owner: this.owner,
      claimId: run.claimId,
      expiresAt,
      threadId: run.threadId,
    });
    if (!renewed) throw new Error(`Beads claim was lost for ${run.taskKey}`);
    this.executions.renew(run.id);
  }

  async release(runId: string, input: ReleaseClaimInput): Promise<void> {
    const run = requireRun(this.executions, runId);
    await this.source.releaseClaim({
      issueId: run.workItemId,
      owner: this.owner,
      claimId: run.claimId,
      expiresAt: run.claimExpiresAt ?? new Date(0).toISOString(),
      resetToQueued: input.resetToQueued,
    });
  }

  async attachThread(runId: string, threadId: string): Promise<void> {
    const run = requireRun(this.executions, runId);
    const expiresAt = leaseExpiry();
    const renewed = await this.source.renewClaim({
      issueId: run.workItemId,
      owner: this.owner,
      claimId: run.claimId,
      expiresAt,
      threadId,
    });
    if (!renewed) throw new Error(`Beads claim was lost for ${run.taskKey}`);
    this.executions.attachThread(run.id, threadId);
  }

  async addComment(
    itemId: string,
    body: string,
    input: AddCommentInput,
  ): Promise<void> {
    await this.source.addComment(
      itemId,
      body,
      input.kind === "agent" ? "Execution agent" : "Symphony Task",
    );
  }

  async transition(itemId: string, state: WorkState): Promise<void> {
    await this.source.transitionExecution(itemId, taskStatus(state));
  }
}
