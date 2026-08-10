import type { TasksApiStore } from "../api/index.js";
import type { ExecutionStore } from "./store.js";
import type { ExecutionRun } from "./types.js";
import type {
  AddCommentInput,
  TrackerAdapter,
  WorkContext,
  WorkItem,
  WorkState,
} from "./tracker.js";

function requireTask(store: TasksApiStore, taskId: string) {
  const task = store.tasks.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}
export class LocalTrackerAdapter implements TrackerAdapter {
  readonly kind = "local" as const;

  constructor(
    private readonly store: TasksApiStore,
    private readonly executions: ExecutionStore,
  ) {}

  async listEligible(input: Parameters<TrackerAdapter["listEligible"]>[0]) {
    return this.executions.listEligibleLocal({
      policy: input.policy,
      maxAttempts: input.maxAttempts,
      limit: input.limit,
    });
  }

  async getContext(itemId: string): Promise<WorkContext> {
    const task = requireTask(this.store, itemId);
    const state: WorkContext["state"] = (() => {
      switch (task.status) {
        case "in_progress":
          return "active";
        case "in_review":
          return "review";
        case "done":
          return "done";
        case "canceled":
          return "canceled";
        default:
          return "queued";
      }
    })();
    return {
      item: {
        id: task.id,
        projectId: task.projectId,
        key: task.key,
        title: task.title,
        version: task.updatedAt,
        labels: this.store.tasks
          .listLabelsForTask(task.id)
          .map((label) => label.id),
      },
      description: task.description,
      tracker: this.kind,
      state,
      recentComments: this.store.tasks
        .listComments(task.id)
        .slice(-5)
        .map((comment) => ({
          author: comment.authorName,
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
    return this.executions.claimLocal({
      item: {
        ...input.item,
        policy: "enabled",
        latestStatus: null,
        latestAttempt: null,
      },
      presetId: input.presetId,
      tokenBudget: input.tokenBudget,
    });
  }

  async renewClaim(runId: string): Promise<void> {
    this.executions.renew(runId);
  }

  async release(
    runId: string,
    input: { resetToQueued: boolean; reason?: string },
  ): Promise<void> {
    const run = this.executions.getRun(runId);
    if (!run) return;
    const task = this.store.tasks.getTask(run.workItemId);
    if (
      input.resetToQueued &&
      (task?.status === "in_progress" || task?.status === "in_review")
    ) {
      this.store.tasks.updateTask(task.id, { status: "todo" });
    }
  }

  async attachThread(runId: string, threadId: string): Promise<void> {
    const run = this.executions.attachThread(runId, threadId);
    const task = requireTask(this.store, run.workItemId);
    if (task.status === "todo") {
      this.store.tasks.updateTask(task.id, { status: "in_progress" });
    }
  }

  async addComment(
    itemId: string,
    body: string,
    input: AddCommentInput,
  ): Promise<void> {
    this.store.tasks.createComment({
      taskId: itemId,
      kind: input.kind,
      authorName:
        input.kind === "agent" ? "Execution agent" : "Symphony Task",
      presetName: input.kind === "agent" ? "Execution engine" : null,
      threadId: input.threadId ?? null,
      body,
      notifiedCount: 0,
    });
  }

  async transition(itemId: string, state: WorkState): Promise<void> {
    const task = requireTask(this.store, itemId);
    const status = (() => {
      switch (state) {
        case "queued":
          return "todo" as const;
        case "active":
          return "in_progress" as const;
        case "review":
          return "in_review" as const;
        case "done":
          return "done" as const;
        case "canceled":
          return "canceled" as const;
      }
    })();
    if (task.status !== status) this.store.tasks.updateTask(task.id, { status });
  }
}
