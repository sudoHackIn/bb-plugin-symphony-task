import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import type { TaskThread, TaskThreadLiveStatus } from "../db";
import {
  createSystemComment,
  publishCommentsChanged,
  publishThreadsChanged,
} from "../delegate";
import {
  TASK_THREAD_IDLE_CHANNEL,
  type TaskThreadIdleNotification,
} from "../notifications/contract.js";

const TERMINAL_LIVE_STATUSES = new Set<TaskThreadLiveStatus>([
  "completed",
  "failed",
]);
export const THREAD_STATUS_RECONCILE_INTERVAL_MS = 5 * 60_000;
export const THREAD_STATUS_IDLE_INTERVAL_MS = 60_000;

type SdkThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

function liveStatusFromThread(thread: SdkThread): TaskThreadLiveStatus {
  if (thread.status === "error") return "failed";
  if (thread.deletedAt !== null) return "completed";

  switch (thread.status) {
    case "starting":
      return "starting";
    case "active":
    case "stopping":
      return "working";
    case "idle":
      return "idle";
  }
}

function trackedThreads(store: TasksApiStore, threadId?: string): TaskThread[] {
  const tracked: TaskThread[] = [];
  for (const task of store.tasks.listTasks()) {
    for (const thread of store.tasks.listTaskThreads(task.id)) {
      if (threadId === undefined || thread.threadId === threadId) {
        tracked.push(thread);
      }
    }
  }
  return tracked;
}

function terminalCommentBody(
  thread: TaskThread,
  liveStatus: Extract<TaskThreadLiveStatus, "completed" | "failed">,
): string {
  return `Thread "${thread.title}" ${liveStatus} — final message posted · ${thread.threadId}`;
}

function sdkErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function transitionThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  thread: TaskThread,
  liveStatus: TaskThreadLiveStatus,
): void {
  if (
    thread.liveStatus === liveStatus ||
    TERMINAL_LIVE_STATUSES.has(thread.liveStatus)
  ) {
    return;
  }

  store.transaction(() => {
    store.tasks.updateTaskThreadStatus(thread.id, liveStatus);
    if (liveStatus === "completed" || liveStatus === "failed") {
      createSystemComment(store.tasks, {
        taskId: thread.taskId,
        presetName: thread.presetName,
        threadId: thread.threadId,
        body: terminalCommentBody(thread, liveStatus),
      });
    }
  });

  publishThreadsChanged(bb, thread.taskId);
  publishCommentsChanged(bb, thread.taskId);
}

function transitionTrackedThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  threadId: string,
  liveStatus: TaskThreadLiveStatus,
): void {
  for (const thread of trackedThreads(store, threadId)) {
    transitionThread(bb, store, thread, liveStatus);
  }
}

function detachTrackedThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  threadId: string,
): void {
  for (const tracked of trackedThreads(store, threadId)) {
    if (!store.tasks.deleteTaskThread(tracked.id)) continue;
    publishThreadsChanged(bb, tracked.taskId);
  }
}

function publishIdleNotification(
  bb: BbPluginApi,
  store: TasksApiStore,
  threads: readonly TaskThread[],
): void {
  if (threads.length === 0) return;

  const tasks = threads.flatMap((thread) => {
    const task = store.tasks.getTask(thread.taskId);
    return task === undefined
      ? []
      : [
          {
            id: task.id,
            key: task.key,
            title: task.title,
            projectId: task.projectId,
          },
        ];
  });
  if (tasks.length === 0) return;

  const payload: TaskThreadIdleNotification = {
    eventId: randomUUID(),
    threadId: threads[0]!.threadId,
    threadTitle: threads[0]!.title,
    tasks,
  };
  bb.realtime.publish(TASK_THREAD_IDLE_CHANNEL, payload);
}

async function reconcileTrackedThread(
  bb: BbPluginApi,
  store: TasksApiStore,
  trackedThread: TaskThread,
): Promise<void> {
  try {
    const thread = await bb.sdk.threads.get({
      threadId: trackedThread.threadId,
    });
    if (thread.deletedAt !== null) {
      detachTrackedThread(bb, store, trackedThread.threadId);
      return;
    }
    transitionThread(bb, store, trackedThread, liveStatusFromThread(thread));
  } catch (error) {
    if (sdkErrorCode(error) === "thread_not_found") {
      detachTrackedThread(bb, store, trackedThread.threadId);
      return;
    }
    bb.log.warn(
      `Could not reconcile task thread ${trackedThread.threadId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function reconcileTrackedThreads(
  bb: BbPluginApi,
  store: TasksApiStore,
  includeTerminal = false,
): Promise<void> {
  const threads = trackedThreads(store).filter(
    (thread) =>
      includeTerminal || !TERMINAL_LIVE_STATUSES.has(thread.liveStatus),
  );

  for (const trackedThread of threads) {
    await reconcileTrackedThread(bb, store, trackedThread);
  }
}

function hasNonTerminalTrackedThreads(store: TasksApiStore): boolean {
  return trackedThreads(store).some(
    (thread) => !TERMINAL_LIVE_STATUSES.has(thread.liveStatus),
  );
}

function waitForNextReconciliation(
  signal: AbortSignal,
  intervalMs: number,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, intervalMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function registerLifecycle(
  bb: BbPluginApi,
  store: TasksApiStore,
): Promise<void> {
  bb.events.on("thread.created", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, liveStatusFromThread(thread));
  });
  bb.events.on("thread.active", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "working");
  });
  bb.events.on("thread.idle", ({ thread }) => {
    const notificationThreads = trackedThreads(store, thread.id).filter(
      (tracked) =>
        tracked.liveStatus !== "idle" &&
        !TERMINAL_LIVE_STATUSES.has(tracked.liveStatus),
    );
    transitionTrackedThread(bb, store, thread.id, "idle");
    publishIdleNotification(bb, store, notificationThreads);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    transitionTrackedThread(bb, store, thread.id, "failed");
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    detachTrackedThread(bb, store, thread.id);
  });

  // Lifecycle events cover live transitions without a full-SDK subscription.
  // Reconciliation remains a low-frequency recovery path for transitions that
  // happen while the plugin is unloaded or while a replacement is loading.
  bb.background.service("thread-status-reconcile", {
    async start(signal) {
      // Also cleans up associations whose threads were deleted while the
      // plugin was stopped, including legacy rows already marked completed.
      await reconcileTrackedThreads(bb, store, true);
      while (!signal.aborted) {
        if (!hasNonTerminalTrackedThreads(store)) {
          await waitForNextReconciliation(
            signal,
            THREAD_STATUS_IDLE_INTERVAL_MS,
          );
          continue;
        }
        await waitForNextReconciliation(
          signal,
          THREAD_STATUS_RECONCILE_INTERVAL_MS,
        );
        if (signal.aborted) break;
        await reconcileTrackedThreads(bb, store);
      }
    },
  });

  await reconcileTrackedThreads(bb, store);
  await reconcileTrackedThreads(bb, store);
}
