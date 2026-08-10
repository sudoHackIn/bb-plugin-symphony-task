import type { BbPluginApi, PluginRpcHandlers } from "@bb/plugin-sdk";
import { z } from "zod";
import type { TasksApiStore } from "../api/index.js";
import {
  handlers as delegationHandlers,
  publishCommentsChanged,
  publishThreadsChanged,
} from "../delegate/index.js";
import { readProjectProviderBinding } from "../providers/runtime.js";
import { executionRpcContract } from "./contract.js";
import { LocalTrackerAdapter } from "./local-tracker.js";
import { createExecutionStore, type ExecutionStore } from "./store.js";
import type { ExecutionRun, ProjectExecutionPolicy } from "./types.js";

const EXECUTION_CHANGED_CHANNEL = "execution:changed";
const SYSTEM_AUTHOR = "Symphony Task";

function publishExecutionChanged(bb: BbPluginApi): void {
  bb.realtime.publish(EXECUTION_CHANGED_CHANNEL, { changedAt: Date.now() });
}

function publishTaskChanged(
  bb: BbPluginApi,
  taskId: string,
  projectId: string,
): void {
  bb.realtime.publish("tasks:changed", { taskId, projectId });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isActive(run: ExecutionRun): boolean {
  return (
    run.status === "claimed" ||
    run.status === "starting" ||
    run.status === "running"
  );
}

function waitForWake(
  signal: AbortSignal,
  timeoutMs: number,
  installWake: (wake: () => void) => void,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      installWake(() => {});
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    signal.addEventListener("abort", finish, { once: true });
    installWake(finish);
  });
}

function addSystemComment(
  store: TasksApiStore,
  taskId: string,
  body: string,
  threadId?: string | null,
): void {
  store.tasks.createComment({
    taskId,
    kind: "system",
    authorName: SYSTEM_AUTHOR,
    presetName: "Execution engine",
    threadId: threadId ?? null,
    body,
    notifiedCount: 0,
  });
}

async function tokenUsage(
  bb: BbPluginApi,
  executions: ExecutionStore,
  run: ExecutionRun,
): Promise<ExecutionRun> {
  if (!run.threadId) return run;
  const events = await bb.sdk.threads.events.list({
    threadId: run.threadId,
    afterSeq: String(run.lastEventSeq),
    limit: "500",
  });
  let lastEventSeq = run.lastEventSeq;
  let tokensUsed = run.tokensUsed;
  for (const event of events) {
    lastEventSeq = Math.max(lastEventSeq, event.seq);
    if (event.type === "thread/tokenUsage/updated") {
      tokensUsed = Math.max(
        tokensUsed,
        event.data.tokenUsage.total.totalTokens,
      );
    }
  }
  if (lastEventSeq !== run.lastEventSeq || tokensUsed !== run.tokensUsed) {
    executions.updateUsage(run.id, tokensUsed, lastEventSeq);
  }
  return executions.getRun(run.id) ?? run;
}

export function registerExecution(
  bb: BbPluginApi,
  store: TasksApiStore,
): void {
  const executions = createExecutionStore(store.database);
  const local = new LocalTrackerAdapter(store, executions);
  const delegate = delegationHandlers(bb, store);
  let wakeCurrent: () => void = () => {};
  const wake = () => wakeCurrent();

  const finishRun = async (
    run: ExecutionRun,
    status: "waiting_review" | "completed" | "failed" | "budget_exhausted" | "canceled",
    detail?: string,
  ) => {
    if (!isActive(run)) return;
    executions.updateRunStatus(run.id, status, detail ?? null);
    const task = store.tasks.getTask(run.workItemId);
    if (task && (status === "failed" || status === "budget_exhausted" || status === "canceled")) {
      if (task.status === "in_progress") {
        store.tasks.updateTask(task.id, { status: "todo" });
      }
    }
    if (task && detail) {
      addSystemComment(store, task.id, detail, run.threadId);
      publishCommentsChanged(bb, task.id);
    }
    if (task) publishTaskChanged(bb, task.id, task.projectId);
    publishExecutionChanged(bb);
  };

  const reconcileRun = async (initial: ExecutionRun): Promise<void> => {
    let run = executions.getRun(initial.id) ?? initial;
    if (!isActive(run)) return;
    if (!run.threadId) {
      if (
        run.claimExpiresAt !== null &&
        new Date(run.claimExpiresAt).valueOf() <= Date.now()
      ) {
        await finishRun(run, "failed", "Execution claim expired before a BB thread was attached.");
      }
      return;
    }
    const threadId = run.threadId;

    try {
      run = await tokenUsage(bb, executions, run);
    } catch (error) {
      bb.log.warn(
        `Could not read token usage for ${run.threadId}: ${errorMessage(error)}`,
      );
    }

    if (
      run.tokenBudget !== null &&
      run.tokensUsed >= run.tokenBudget &&
      isActive(run)
    ) {
      try {
        await bb.sdk.threads.stop({ threadId });
      } catch (error) {
        bb.log.warn(
          `Could not stop token-limited thread ${run.threadId}: ${errorMessage(error)}`,
        );
      }
      await finishRun(
        run,
        "budget_exhausted",
        `Execution stopped after reaching its ${run.tokenBudget.toLocaleString()} token budget (observed ${run.tokensUsed.toLocaleString()}).`,
      );
      return;
    }

    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.deletedAt !== null) {
        await finishRun(run, "canceled", "Execution thread was deleted.");
        return;
      }
      if (thread.status === "error") {
        await finishRun(run, "failed", "Execution thread failed.");
        return;
      }
      if (thread.status === "idle") {
        const task = store.tasks.getTask(run.workItemId);
        if (task?.status === "in_review") {
          await finishRun(run, "waiting_review");
        } else if (task?.status === "done" || task?.status === "canceled") {
          await finishRun(run, "completed");
        } else {
          await finishRun(
            run,
            "failed",
            "Worker became idle before moving the task to review. The task was returned to Todo for retry.",
          );
        }
        return;
      }
      executions.updateRunStatus(
        run.id,
        thread.status === "active" || thread.status === "stopping"
          ? "running"
          : "starting",
      );
      executions.renew(run.id);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : null;
      if (code === "thread_not_found") {
        await finishRun(run, "canceled", "Execution thread no longer exists.");
        return;
      }
      bb.log.warn(
        `Could not reconcile execution ${run.id}: ${errorMessage(error)}`,
      );
    }
  };

  const startClaimedRun = async (
    run: ExecutionRun,
    policy: ProjectExecutionPolicy,
  ): Promise<void> => {
    try {
      const tokenInstruction =
        run.tokenBudget === null
          ? ""
          : `This execution has a ${run.tokenBudget.toLocaleString()} token budget. Keep the work focused; the engine stops the thread after the observed usage reaches the limit.`;
      const result = await delegate.delegate({
        taskId: run.workItemId,
        presetId: policy.presetId!,
        extraInstructions: [
          "This is an automated Symphony Task execution. Before finishing, move the task to in_review and leave a concise task comment with the result. If blocked, explain the blocker in a task comment.",
          tokenInstruction,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      await local.attachThread(run.id, result.threadId);
      addSystemComment(
        store,
        run.workItemId,
        `Automatic execution started · attempt ${run.attempt}`,
        result.threadId,
      );
      publishThreadsChanged(bb, run.workItemId);
      publishCommentsChanged(bb, run.workItemId);
      publishTaskChanged(bb, run.workItemId, run.projectId);
      publishExecutionChanged(bb);
    } catch (error) {
      await local.release(run.id, `Could not start worker: ${errorMessage(error)}`);
      publishTaskChanged(bb, run.workItemId, run.projectId);
      publishExecutionChanged(bb);
    }
  };

  const dispatchEligible = async (): Promise<void> => {
    const config = executions.getConfig();
    if (!config.enabled) return;
    let remaining = Math.max(0, config.maxWorkers - executions.countActiveRuns());
    if (remaining === 0) return;

    for (const policy of executions.listProjectPolicies()) {
      if (remaining === 0) break;
      if (policy.mode === "off" || !policy.presetId) continue;
      const binding = await readProjectProviderBinding(bb, policy.projectId);
      // Legacy automatic projects can resolve to Beads depending on their
      // workspace. Requiring an explicit Local source keeps autonomous work
      // deterministic and prevents claiming a shadow record by mistake.
      if (binding?.provider !== "local") continue;

      const projectLimit = policy.maxWorkers ?? config.maxWorkers;
      const projectCapacity = Math.max(
        0,
        projectLimit - executions.countActiveRuns(policy.projectId),
      );
      const capacity = Math.min(remaining, projectCapacity);
      if (capacity === 0) continue;
      const items = await local.listEligible({
        policy,
        maxAttempts: config.maxAttempts,
        limit: capacity,
      });
      for (const item of items) {
        const run = await local.claim({
          item,
          presetId: policy.presetId,
          tokenBudget: policy.tokenBudget ?? config.defaultTokenBudget,
        });
        if (!run) continue;
        remaining -= 1;
        await startClaimedRun(run, policy);
        if (remaining === 0) break;
      }
    }
  };

  let ticking: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    if (ticking) return ticking;
    ticking = (async () => {
      for (const run of executions.listActiveRuns()) {
        await reconcileRun(run);
      }
      await dispatchEligible();
    })()
      .catch((error: unknown) => {
        bb.log.error(`Execution engine tick failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        ticking = null;
      });
    return ticking;
  };

  const dashboard = async () => {
    const config = executions.getConfig();
    const policies = new Map(
      executions.listProjectPolicies().map((policy) => [policy.projectId, policy]),
    );
    const projects = await Promise.all(
      store.tasks.listProjects().map(async (project) => {
        const binding = await readProjectProviderBinding(bb, project.id);
        const source: "local" | "beads" | "jira" | "automatic" =
          binding?.provider ?? "automatic";
        const supported = source === "local";
        return {
          id: project.id,
          name: project.name,
          source,
          supported,
          supportDetail: supported
            ? "Local tracker supports transactional claims."
            : source === "automatic"
              ? "Choose Local Tasks explicitly before enabling autonomous execution."
              : source === "beads"
                ? "Autonomous execution is unavailable for Beads. Start an OpenSpec workflow from Dispatch."
                : "Jira execution claims are not implemented yet.",
          policy:
            policies.get(project.id) ??
            executions.getProjectPolicy(project.id),
        };
      }),
    );
    const supportedProjects = new Set(
      projects.filter((project) => project.supported).map((project) => project.id),
    );
    return {
      config,
      activeWorkers: executions.countActiveRuns(),
      projects,
      presets: store.tasks
        .listPresets()
        .map((preset) => ({ id: preset.id, name: preset.name })),
      tasks: executions
        .listLocalAutomationTasks()
        .filter((task) => supportedProjects.has(task.projectId))
        .map((task) => ({
          id: task.id,
          projectId: task.projectId,
          key: task.key,
          title: task.title,
          policy: task.policy,
          latestStatus: task.latestStatus,
          latestAttempt: task.latestAttempt,
        })),
      runs: executions.listRuns(100),
    };
  };

  const rpcHandlers: PluginRpcHandlers<typeof executionRpcContract> = {
    getExecutionDashboard: dashboard,
    async updateExecutionConfig(input) {
      const config = executions.updateConfig(input);
      publishExecutionChanged(bb);
      wake();
      return { config };
    },
    async setProjectExecutionPolicy(input) {
      const project = store.tasks.getProject(input.projectId);
      if (!project) throw new Error(`Project not found: ${input.projectId}`);
      if (input.presetId && !store.tasks.getPreset(input.presetId)) {
        throw new Error(`Preset not found: ${input.presetId}`);
      }
      const policy = executions.setProjectPolicy(input);
      publishExecutionChanged(bb);
      wake();
      return { policy };
    },
    async setTaskExecutionPolicy(input) {
      if (input.tracker === "local") {
        const task = store.tasks.getTask(input.workItemId);
        if (!task || task.projectId !== input.projectId) {
          throw new Error(`Task not found: ${input.workItemId}`);
        }
      }
      executions.setTaskPolicy(input);
      publishExecutionChanged(bb);
      wake();
      return { ok: true as const };
    },
    async stopExecutionRun(input) {
      const run = executions.getRun(input.runId);
      if (!run) throw new Error(`Execution run not found: ${input.runId}`);
      if (run.threadId && isActive(run)) {
        await bb.sdk.threads.stop({ threadId: run.threadId }).catch((error) => {
          bb.log.warn(`Could not stop ${run.threadId}: ${errorMessage(error)}`);
        });
      }
      await finishRun(run, "canceled", "Execution stopped from the control panel.");
      return { ok: true as const };
    },
    async retryExecutionRun(input) {
      const run = executions.getRun(input.runId);
      if (!run) throw new Error(`Execution run not found: ${input.runId}`);
      executions.requestRetry(run.id);
      const task = store.tasks.getTask(run.workItemId);
      if (task && task.status !== "todo") {
        store.tasks.updateTask(task.id, { status: "todo" });
        publishTaskChanged(bb, task.id, task.projectId);
      }
      publishExecutionChanged(bb);
      wake();
      return { ok: true as const };
    },
  };
  bb.rpc.register(executionRpcContract, rpcHandlers);

  bb.events.on("thread.active", ({ thread }) => {
    const run = executions.getRunByThread(thread.id);
    if (!run || !isActive(run)) return;
    executions.updateRunStatus(run.id, "running");
    executions.renew(run.id);
    publishExecutionChanged(bb);
  });
  bb.events.on("thread.idle", ({ thread }) => {
    const run = executions.getRunByThread(thread.id);
    if (run) void reconcileRun(run);
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    const run = executions.getRunByThread(thread.id);
    if (run) void finishRun(run, "failed", error ?? "Execution thread failed.");
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    const run = executions.getRunByThread(thread.id);
    if (run) void finishRun(run, "canceled", "Execution thread was deleted.");
  });

  bb.agents.registerTool({
    name: "symphony_task_comment",
    description: "Add a progress or result comment to the Symphony task attached to this execution thread.",
    parameters: z.object({ body: z.string().trim().min(1) }).strict(),
    async execute({ body }, context) {
      const run = executions.getRunByThread(context.threadId);
      if (!run) throw new Error("This thread is not attached to a Symphony execution run");
      store.tasks.createComment({
        taskId: run.workItemId,
        kind: "agent",
        authorName: "Execution agent",
        presetName: "Execution engine",
        threadId: context.threadId,
        body,
        notifiedCount: 0,
      });
      publishCommentsChanged(bb, run.workItemId);
      return `Comment added to ${run.taskKey}.`;
    },
  });
  bb.agents.registerTool({
    name: "symphony_task_update",
    description: "Move the Symphony task attached to this execution thread to a new workflow status.",
    parameters: z
      .object({
        status: z.enum(["todo", "in_progress", "in_review", "done", "canceled"]),
      })
      .strict(),
    async execute({ status }, context) {
      const run = executions.getRunByThread(context.threadId);
      if (!run) throw new Error("This thread is not attached to a Symphony execution run");
      store.tasks.updateTask(run.workItemId, { status });
      publishTaskChanged(bb, run.workItemId, run.projectId);
      return `${run.taskKey} moved to ${status}.`;
    },
  });
  bb.agents.configure((context) => {
    const run = executions.getRunByThread(context.thread.id);
    if (!run) return { tools: [], skills: [], instructions: "" };
    return {
      tools: ["symphony_task_comment", "symphony_task_update"],
      skills: [],
      instructions:
        `You are executing Symphony task ${run.taskKey}. ` +
        "Use symphony_task_comment for substantive progress and symphony_task_update to move successful work to in_review before ending the turn. Do not mark the task done; human review owns that transition.",
    };
  });

  bb.background.service("execution-engine", {
    async start(signal) {
      while (!signal.aborted) {
        await tick();
        const intervalMs = executions.getConfig().pollIntervalSeconds * 1_000;
        await waitForWake(signal, intervalMs, (next) => {
          wakeCurrent = next;
        });
      }
    },
  });
}
