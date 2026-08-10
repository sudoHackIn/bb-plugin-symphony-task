import { listAllTasks, useTasksQuery } from "../../shell/data.js";
import { useRpc } from "@bb/plugin-sdk/app";
import type { WorkflowRpcContract } from "../../workflows/contract.js";
import type {
  Label,
  Task,
  TaskPriority,
  TaskStatus,
  TaskThread,
} from "../../shared/contract.js";

export interface ListTaskFilters {
  statuses: readonly TaskStatus[];
  priorities: readonly TaskPriority[];
  /**
   * `null` means no label filter. An array (including empty) is an active
   * label filter: empty matches nothing once the catalog is known, which is
   * how stale/deleted label names recover without silently showing all tasks.
   */
  labelIds: readonly string[] | null;
}

/**
 * Server-side filtered task list. Subtasks are excluded (parentTaskId: null),
 * matching the design mock — they surface on their parent's detail page.
 */
export function useListTasks(
  projectId: string | null,
  activeOnly: boolean,
  filters: ListTaskFilters,
) {
  return useTasksQuery(
    async (rpc) =>
      listAllTasks(rpc, {
        ...(projectId === null ? {} : { projectId }),
        ...(filters.statuses.length > 0
          ? { statuses: [...filters.statuses] }
          : {}),
        ...(filters.priorities.length > 0
          ? { priorities: [...filters.priorities] }
          : {}),
        ...(filters.labelIds !== null
          ? { labelIds: [...filters.labelIds] }
          : {}),
        activeOnly,
        parentTaskId: null,
      }),
    ["tasks:changed", "threads:changed"],
    [
      projectId,
      activeOnly,
      filters.statuses.join(),
      filters.priorities.join(),
      filters.labelIds === null ? "" : `active:${filters.labelIds.join()}`,
    ],
  );
}

/**
 * Labels for one or many projects. The contract only exposes per-project
 * listLabels, so cross-project routes fan out one call per project. (No shell
 * hook exists for labels; implemented locally per worker ownership rules.)
 */
export function useLabels(projectIds: readonly string[]) {
  return useTasksQuery<Label[]>(
    async (rpc) => {
      const results = await Promise.all(
        projectIds.map((projectId) => rpc.call("listLabels", { projectId })),
      );
      return results.flatMap((result) => result.labels);
    },
    ["projects:changed"],
    [projectIds.join()],
  );
}

export interface TaskRowMeta {
  /** Threads currently starting or working. Historical attachments (idle,
   * completed, failed) are excluded — list rows only surface live activity. */
  activeThreads: TaskThread[];
  workflowStatus: "running" | "waiting_agent" | "waiting_human" | "completed" | "failed" | null;
}

/**
 * Live-activity metadata for list rows. Comments and attachments are detail-
 * view concerns and are deliberately not fetched here. Fetch threads in
 * bounded batches so a large project does not issue one RPC request per row.
 */
export function useTaskListMeta(tasks: readonly Task[] | undefined) {
  const taskIds = (tasks ?? []).map((task) => task.id);
  return useTasksQuery<Map<string, TaskRowMeta>>(
    async (rpc) => {
      const batches: string[][] = [];
      for (let offset = 0; offset < taskIds.length; offset += 500) {
        batches.push(taskIds.slice(offset, offset + 500));
      }
      const results = await Promise.all(
        batches.map((ids) =>
          rpc.call("listTaskThreadsForTasks", { taskIds: ids }),
        ),
      );
      const meta = new Map<string, TaskRowMeta>(
        taskIds.map((taskId) => [taskId, { activeThreads: [], workflowStatus: null }]),
      );
      for (const thread of results.flatMap((result) => result.taskThreads)) {
        if (
          thread.liveStatus === "starting" ||
          thread.liveStatus === "working"
        ) {
          meta.get(thread.taskId)?.activeThreads.push(thread);
        }
      }
      return meta;
    },
    ["threads:changed", "tasks:changed"],
    [taskIds.join()],
  );
}

export function useWorkflowSummaries(tasks: readonly Task[] | undefined) {
  const rpc = useRpc<WorkflowRpcContract>();
  const taskIds = (tasks ?? []).map((task) => task.id);
  return useTasksQuery(async () => {
    const result = await rpc.call("listWorkflowSummaries", { taskIds });
    return new Map(result.workflows.map((workflow) => [workflow.taskId, workflow]));
  }, ["workflow:changed"], [taskIds.join()]);
}
