import type { BbPluginApi, PluginRpcHandlers, PluginSettingsHandle } from "@bb/plugin-sdk";
import type { TasksApiStore } from "../api/index.js";
import {
  publishCommentsChanged,
  registerHandlers,
} from "../api/index.js";
import {
  TASKS_PAGE_MAX_LIMIT,
  type TaskSort,
} from "../shared/pagination.js";
import {
  tasksRpcContract,
  type Comment,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type TaskThread,
} from "../shared/contract.js";
import type {
  TaskLinkType,
  TaskSource,
  UnifiedComment,
  UnifiedTask,
} from "../lib/task-source.js";
import {
  BEADS_LINK_TYPES,
  taskProvidersRpcContract,
} from "./contract.js";
import {
  findProviderTask,
  providerTask,
  resolveProjectProvider,
  saveProjectProvider,
  sourceStatus,
  syntheticUlid,
} from "./runtime.js";

const TARGETS_PREFIX = "task-targets:";
const EXTERNAL_THREADS_PREFIX = "external-task-threads:";
const BEADS_LINK_TYPE_SET = new Set<string>(BEADS_LINK_TYPES);

interface ExternalThreadRecord extends TaskThread {
  targetProjectId: string;
}

function targetsKey(taskId: string): string {
  return `${TARGETS_PREFIX}${taskId}`;
}

function externalThreadsKey(taskId: string): string {
  return `${EXTERNAL_THREADS_PREFIX}${taskId}`;
}

function sdkErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function liveStatus(status: string): TaskThread["liveStatus"] {
  if (status === "starting") return "starting";
  if (status === "active" || status === "stopping") return "working";
  if (status === "error") return "failed";
  return "idle";
}

type SettingsHandle = PluginSettingsHandle<{
  beadsExecutable: { type: "string"; label: string; description: string; default: string };
  jiraBaseUrl: { type: "string"; label: string; default: string };
  jiraEmail: { type: "string"; label: string; default: string };
  jiraApiToken: { type: "string"; label: string; secret: true };
}>;

interface ExternalMatch {
  projectId: string;
  sourceTask: UnifiedTask;
  task: Task;
  source: NonNullable<Awaited<ReturnType<typeof resolveProjectProvider>>["source"]>;
  readOnly: boolean;
}

function externalComment(
  task: Task,
  comment: UnifiedComment,
): Comment {
  return {
    id: syntheticUlid(task.id, `comment:${comment.id}`),
    taskId: task.id,
    kind: "user",
    authorName: comment.author,
    presetName: null,
    threadId: null,
    body: comment.body,
    notifiedCount: 0,
    createdAt: comment.createdAt,
  };
}

function filterAndSort(
  tasks: Task[],
  input: {
    statuses?: TaskStatus[];
    priorities?: TaskPriority[];
    labelIds?: string[];
    activeOnly?: boolean;
    parentTaskId?: string | null;
    search?: string;
    sort?: TaskSort;
    limit?: number;
  },
): Task[] {
  if (input.activeOnly || (input.labelIds?.length ?? 0) > 0) return [];
  const search = input.search?.trim().toLocaleLowerCase();
  const result = tasks.filter((task) => {
    if (input.statuses && !input.statuses.includes(task.status)) return false;
    if (input.priorities && !input.priorities.includes(task.priority)) return false;
    if (
      input.parentTaskId !== undefined &&
      task.parentTaskId !== input.parentTaskId
    )
      return false;
    if (search && !`${task.key}\n${task.title}\n${task.description}`.toLocaleLowerCase().includes(search))
      return false;
    return true;
  });
  const priorityRank: Record<TaskPriority, number> = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
    none: 4,
  };
  if (input.sort === "priority") {
    result.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);
  } else if (input.sort === "due") {
    result.sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  } else {
    result.sort((a, b) => a.position - b.position);
  }
  return result.slice(0, input.limit ?? TASKS_PAGE_MAX_LIMIT);
}

export function registerProviderAwareTasksApi(
  bb: BbPluginApi,
  store: TasksApiStore,
  settings: SettingsHandle,
): PluginRpcHandlers<typeof tasksRpcContract> {
  const local = registerHandlers(bb, store);
  const externalTaskCounts = new Map<string, number>();
  const REVISION_CHECK_INTERVAL_MS = 5_000;
  const FALLBACK_CACHE_TTL_MS = 5_000;

  const removeExternalThreadReferences = async (
    threadId: string,
  ): Promise<void> => {
    const keys = await bb.storage.kv.list(EXTERNAL_THREADS_PREFIX);
    for (const key of keys) {
      const records =
        (await bb.storage.kv.get<ExternalThreadRecord[]>(key)) ?? [];
      const next = records.filter((record) => record.threadId !== threadId);
      if (next.length === records.length) continue;
      if (next.length === 0) await bb.storage.kv.delete(key);
      else await bb.storage.kv.set(key, next);
      const taskId = key.slice(EXTERNAL_THREADS_PREFIX.length);
      bb.realtime.publish("threads:changed", { taskId });
      bb.realtime.publish("tasks:changed", { taskId });
    }
  };

  bb.events.on("thread.deleted", async ({ thread }) => {
    await removeExternalThreadReferences(thread.id);
  });

  const readSourceRevision = async (
    source: TaskSource,
  ): Promise<string | null> => {
    if (!source.revision) return null;
    try {
      return await source.revision();
    } catch {
      // Older/incompatible Beads builds degrade to the previous short TTL
      // behavior instead of making task reads unavailable.
      return null;
    }
  };

  const loadExternalTasks = async (
    projectId: string,
    resolvedOverride?: Awaited<ReturnType<typeof resolveProjectProvider>>,
  ) => {
    const project = store.tasks.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const resolved =
      resolvedOverride ?? (await resolveProjectProvider(bb, settings, project));
    if (resolved.selected === "local") return null;
    if (!resolved.source) {
      throw new Error(`${resolved.selected === "jira" ? "Jira" : "Beads"} is not available for this project`);
    }
    const sourceTasks = await resolved.source.list();
    const previousCount = externalTaskCounts.get(projectId);
    externalTaskCounts.set(projectId, sourceTasks.length);
    if (previousCount !== sourceTasks.length) {
      bb.realtime.publish("projects:changed", { projectId });
    }
    const cacheRevision = await readSourceRevision(resolved.source);
    return {
      resolved,
      sourceTasks,
      tasks: sourceTasks.map((task, index) => providerTask(projectId, task, index)),
      cacheRevision,
    };
  };

  type ExternalTasksValue = Awaited<ReturnType<typeof loadExternalTasks>>;
  interface ExternalTasksCacheEntry {
    value?: ExternalTasksValue;
    promise: Promise<ExternalTasksValue>;
    nextRevisionCheckAt: number;
    expiresAt: number;
  }

  // A task card mounts several independent data consumers at once. Coalesce
  // both revision checks and provider reads. Beads values remain cached while
  // DOLT_HASHOF_DB is unchanged; sources without a revision use a short TTL.
  const externalTasksCache = new Map<string, ExternalTasksCacheEntry>();

  const cacheExternalTasksPromise = (
    projectId: string,
    promise: Promise<ExternalTasksValue>,
  ): Promise<ExternalTasksValue> => {
    const now = Date.now();
    const entry: ExternalTasksCacheEntry = {
      promise,
      nextRevisionCheckAt: now + REVISION_CHECK_INTERVAL_MS,
      expiresAt: now + FALLBACK_CACHE_TTL_MS,
    };
    externalTasksCache.set(projectId, entry);
    void promise.then(
      (value) => {
        if (externalTasksCache.get(projectId) !== entry) return;
        entry.value = value;
        const settledAt = Date.now();
        entry.nextRevisionCheckAt =
          settledAt + REVISION_CHECK_INTERVAL_MS;
        entry.expiresAt = settledAt + FALLBACK_CACHE_TTL_MS;
      },
      () => {
        if (externalTasksCache.get(projectId) === entry) {
          externalTasksCache.delete(projectId);
        }
      },
    );
    return promise;
  };

  const externalTasks = async (
    projectId: string,
  ): Promise<ExternalTasksValue> => {
    const cached = externalTasksCache.get(projectId);
    if (!cached) {
      return cacheExternalTasksPromise(
        projectId,
        loadExternalTasks(projectId),
      );
    }
    if (cached.value === undefined) return cached.promise;

    const now = Date.now();
    const value = cached.value;
    if (value?.cacheRevision && value.resolved.source?.revision) {
      if (cached.nextRevisionCheckAt > now) return value;
      const promise = value.resolved.source
        .revision()
        .then((revision) =>
          revision === value.cacheRevision
            ? value
            : loadExternalTasks(projectId, value.resolved),
        )
        .catch(() => ({ ...value, cacheRevision: null }));
      return cacheExternalTasksPromise(projectId, Promise.resolve(promise));
    }

    if (cached.expiresAt > now) return value;
    return cacheExternalTasksPromise(projectId, loadExternalTasks(projectId));
  };
  const invalidateExternalTasks = (projectId: string) => {
    externalTasksCache.delete(projectId);
  };
  settings.onChange(() => {
    externalTasksCache.clear();
    externalTaskCounts.clear();
  });

  const findExternalInProject = async (
    projectId: string,
    predicate: (task: Task) => boolean,
  ): Promise<ExternalMatch | null> => {
    const listed = await externalTasks(projectId);
    if (!listed) return null;
    const index = listed.tasks.findIndex(predicate);
    if (index < 0) return null;
    return {
      projectId,
      sourceTask: listed.sourceTasks[index]!,
      task: listed.tasks[index]!,
      source: listed.resolved.source!,
      readOnly:
        listed.resolved.providers.find(
          (item) => item.id === listed.resolved.selected,
        )?.readOnly ?? false,
    };
  };

  const findExternal = async (
    predicate: (task: Task) => boolean,
  ): Promise<ExternalMatch | null> => {
    for (const project of store.tasks.listProjects()) {
      const match = await findExternalInProject(project.id, predicate);
      if (match) return match;
    }
    return null;
  };

  const executionTargets = async (taskId: string, taskProjectId: string) => {
    const saved = await bb.storage.kv.get<string[]>(targetsKey(taskId));
    if (saved !== undefined) return { projectIds: saved, explicit: true };
    const project = store.tasks.getProject(taskProjectId);
    return {
      projectIds: project?.linkedBbProjectId ? [project.linkedBbProjectId] : [],
      explicit: false,
    };
  };

  const handlers: PluginRpcHandlers<typeof tasksRpcContract> = {
    ...local,
    async createProject(input) {
      const { taskProvider, jiraJql = "", ...projectInput } = input;
      const result = await local.createProject(projectInput);
      // Preserve the original Tasks CLI/seed behavior. NewProjectDialog always
      // supplies a provider, while older callers keep automatic Beads/local
      // resolution until they save an explicit source.
      if (taskProvider === undefined) return result;

      try {
        const resolved = await resolveProjectProvider(
          bb,
          settings,
          result.project,
        );
        const provider = resolved.providers.find(
          (item) => item.id === taskProvider,
        );
        if (!provider?.available) {
          throw new Error(
            `${provider?.name ?? taskProvider} is not available: ${provider?.detail ?? "check plugin settings"}`,
          );
        }
        await saveProjectProvider(
          bb,
          result.project.id,
          taskProvider,
          jiraJql,
        );
        invalidateExternalTasks(result.project.id);
        return result;
      } catch (error) {
        // Project creation and provider selection are one user operation. A
        // failed provider binding must not leave an empty orphan project.
        await local.deleteProject({
          projectId: result.project.id,
          force: true,
        });
        throw error;
      }
    },
    async updateProject(input) {
      const result = await local.updateProject(input);
      invalidateExternalTasks(input.projectId);
      externalTaskCounts.delete(input.projectId);
      return result;
    },
    async deleteProject(input) {
      const project = store.tasks.getProject(input.projectId);
      if (!project) return local.deleteProject(input);
      // Deletion must not depend on an external provider being configured or
      // reachable. Local task-owned bindings can be cleaned deterministically;
      // external task bindings become unreachable with the deleted view.
      const taskIds = store.tasks
        .listTasks({ projectId: input.projectId })
        .map((task) => task.id);
      const result = await local.deleteProject(input);
      if (result.ok && result.deleted) {
        invalidateExternalTasks(input.projectId);
        externalTaskCounts.delete(input.projectId);
        await bb.storage.kv.delete(`task-provider:${input.projectId}`);
        for (const taskId of taskIds) {
          await bb.storage.kv.delete(targetsKey(taskId));
          await bb.storage.kv.delete(externalThreadsKey(taskId));
        }
      }
      return result;
    },
    async createTask(input) {
      const listed = await externalTasks(input.projectId);
      if (!listed) return local.createTask(input);
      const parent =
        input.parentTaskId === null || input.parentTaskId === undefined
          ? undefined
          : listed.sourceTasks.find(
              (task) =>
                syntheticUlid(input.projectId, task.id) === input.parentTaskId,
            );
      if (input.parentTaskId && !parent)
        throw new Error(`Parent task not found: ${input.parentTaskId}`);
      const created = await listed.resolved.source!.create({
        title: input.title,
        description: input.description,
        priority: input.priority,
        parentId: parent?.id,
      });
      invalidateExternalTasks(input.projectId);
      const task = providerTask(input.projectId, created, listed.tasks.length);
      bb.realtime.publish("tasks:changed", { taskId: task.id, projectId: task.projectId });
      return { ok: true, task };
    },
    async getTask(input) {
      const stored = await local.getTask(input);
      if (stored.task) return stored;
      const match = input.projectId
        ? await findExternalInProject(
            input.projectId,
            (task) => task.id === input.taskId,
          )
        : await findExternal((task) => task.id === input.taskId);
      return { task: match?.task ?? null };
    },
    async getTaskByKey(input) {
      const stored = await local.getTaskByKey(input);
      if (stored.task) return stored;
      const key = input.taskKey.toLocaleLowerCase();
      const projectId =
        input.projectId ??
        store.tasks
          .listProjects()
          .find((project) =>
            key.startsWith(`${project.prefix.toLocaleLowerCase()}-`),
          )?.id;
      if (!projectId) return { task: null };
      const match = await findExternalInProject(
        projectId,
        (task) => task.key.toLocaleLowerCase() === key,
      );
      return { task: match?.task ?? null };
    },
    async updateTask(input) {
      const stored = store.tasks.getTask(input.taskId);
      if (stored) return local.updateTask(input);
      const match = await findExternal((task) => task.id === input.taskId);
      if (!match) throw new Error(`Task not found: ${input.taskId}`);
      if (match.readOnly) throw new Error("Jira tasks are read-only");
      if (input.labelIds !== undefined) {
        throw new Error("Source labels are read-only");
      }
      let parentId: string | null | undefined;
      if (input.parentTaskId !== undefined) {
        if (input.parentTaskId === null) parentId = null;
        else {
          const parent = await findExternal(
            (task) => task.id === input.parentTaskId,
          );
          if (!parent || parent.projectId !== match.projectId)
            throw new Error(`Parent task not found: ${input.parentTaskId}`);
          parentId = parent.sourceTask.id;
        }
      }
      const updated = await match.source.update(match.sourceTask.id, {
        title: input.title,
        description: input.description,
        status: input.status === undefined ? undefined : sourceStatus(input.status),
        priority: input.priority,
        parentId,
      });
      invalidateExternalTasks(match.projectId);
      const task = providerTask(match.projectId, updated, match.task.position);
      bb.realtime.publish("tasks:changed", { taskId: task.id, projectId: task.projectId });
      return { ok: true, task };
    },
    async deleteTask(input) {
      if (store.tasks.getTask(input.taskId)) return local.deleteTask(input);
      const match = await findExternal((task) => task.id === input.taskId);
      if (!match) return { deleted: false };
      throw new Error(
        match.readOnly ? "Jira tasks are read-only" : "Deleting Beads tasks is not supported yet",
      );
    },
    async listTasks(input) {
      if (input.cursor) throw new Error("External provider cursors are not supported");
      if (input.projectId) {
        const listed = await externalTasks(input.projectId);
        if (!listed) return local.listTasks(input);
        return { tasks: filterAndSort(listed.tasks, input), nextCursor: null };
      }
      const tasks: Task[] = [];
      for (const project of store.tasks.listProjects()) {
        const listed = await externalTasks(project.id);
        if (listed) tasks.push(...listed.tasks);
        else {
          const page = await local.listTasks({
            ...input,
            projectId: project.id,
            limit: TASKS_PAGE_MAX_LIMIT,
            cursor: undefined,
          });
          tasks.push(...page.tasks);
        }
      }
      return { tasks: filterAndSort(tasks, input), nextCursor: null };
    },
    async createComment(input) {
      if (store.tasks.getTask(input.taskId)) return local.createComment(input);
      const match = await findExternal((task) => task.id === input.taskId);
      if (!match) throw new Error(`Task not found: ${input.taskId}`);
      if (!match.source.addComment) {
        throw new Error(`Comments are not supported by ${match.source.id}`);
      }
      const body = input.body.trim();
      if (!body) {
        throw new Error(
          "Attachment-only comments are not supported for external tasks",
        );
      }
      const comment = externalComment(
        match.task,
        await match.source.addComment(match.sourceTask.id, body, "You"),
      );
      publishCommentsChanged(bb, match.task.id, 0);
      return { comment };
    },
    async listComments(input) {
      if (store.tasks.getTask(input.taskId)) return local.listComments(input);
      const match = await findExternal((task) => task.id === input.taskId);
      if (!match) throw new Error(`Task not found: ${input.taskId}`);
      if (!match.source.listComments) return { comments: [] };
      const comments = await match.source.listComments(match.sourceTask.id);
      return {
        comments: comments.map((comment) => ({
          ...externalComment(match.task, comment),
          threadTitle: null,
          provider: null,
        })),
      };
    },
    async boardMove(input) {
      if (store.tasks.getTask(input.taskId)) return local.boardMove(input);
      const match = await findExternal((task) => task.id === input.taskId);
      if (!match) throw new Error(`Task not found: ${input.taskId}`);
      if (match.readOnly) throw new Error("Jira tasks are read-only");
      const updated = await match.source.update(match.sourceTask.id, {
        status: sourceStatus(input.status),
      });
      const task = providerTask(match.projectId, updated, match.task.position);
      bb.realtime.publish("tasks:changed", { taskId: task.id, projectId: task.projectId });
      return { ok: true, task };
    },
    async listTaskThreads(input) {
      if (store.tasks.getTask(input.taskId)) return local.listTaskThreads(input);
      const key = externalThreadsKey(input.taskId);
      const records =
        (await bb.storage.kv.get<ExternalThreadRecord[]>(key)) ?? [];
      const resolved = await Promise.all(
        records.map(async (record): Promise<TaskThread | null> => {
          const { targetProjectId: _targetProjectId, ...taskThread } = record;
          try {
            const thread = await bb.sdk.threads.get({ threadId: record.threadId });
            if (thread.deletedAt !== null) return null;
            return {
              ...taskThread,
              liveStatus: liveStatus(thread.status),
              updatedAt: new Date(thread.updatedAt).toISOString(),
            };
          } catch (error) {
            if (sdkErrorCode(error) === "thread_not_found") return null;
            return { ...taskThread, liveStatus: "completed" };
          }
        }),
      );
      const taskThreads = resolved.filter(
        (thread): thread is TaskThread => thread !== null,
      );
      if (taskThreads.length !== records.length) {
        const liveIds = new Set(taskThreads.map((thread) => thread.threadId));
        const next = records.filter((record) => liveIds.has(record.threadId));
        if (next.length === 0) await bb.storage.kv.delete(key);
        else await bb.storage.kv.set(key, next);
        bb.realtime.publish("threads:changed", { taskId: input.taskId });
        bb.realtime.publish("tasks:changed", { taskId: input.taskId });
      }
      return { taskThreads };
    },
    async attachTaskThread(input) {
      if (store.tasks.getTask(input.taskId)) {
        return local.attachTaskThread(input);
      }
      const match = await findExternal((task) => task.id === input.taskId);
      if (!match) throw new Error(`Task not found: ${input.taskId}`);
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      const title = (
        thread.title ??
        thread.titleFallback ??
        `${match.task.key} · ${match.task.title}`
      ).slice(0, 120);
      const now = new Date().toISOString();
      const records =
        (await bb.storage.kv.get<ExternalThreadRecord[]>(
          externalThreadsKey(input.taskId),
        )) ?? [];
      const existing = records.find(
        (record) => record.threadId === input.threadId,
      );
      const taskThread: ExternalThreadRecord = {
        id: existing?.id ?? syntheticUlid(input.taskId, input.threadId),
        taskId: input.taskId,
        threadId: input.threadId,
        presetName: "Attached",
        title,
        liveStatus:
          thread.deletedAt !== null ? "completed" : liveStatus(thread.status),
        attachedAt: existing?.attachedAt ?? now,
        updatedAt: now,
        targetProjectId:
          existing?.targetProjectId ?? thread.projectId,
      };
      await bb.storage.kv.set(externalThreadsKey(input.taskId), [
        ...records.filter((record) => record.threadId !== input.threadId),
        taskThread,
      ]);
      bb.realtime.publish("threads:changed", { taskId: input.taskId });
      bb.realtime.publish("tasks:changed", {
        taskId: input.taskId,
        projectId: match.projectId,
      });
      const { targetProjectId: _targetProjectId, ...result } = taskThread;
      return { taskThread: result };
    },
    async detachTaskThread(input) {
      if (store.tasks.getTask(input.taskId)) {
        return local.detachTaskThread(input);
      }
      const key = externalThreadsKey(input.taskId);
      const records =
        (await bb.storage.kv.get<ExternalThreadRecord[]>(key)) ?? [];
      const next = records.filter(
        (record) => record.threadId !== input.threadId,
      );
      const detached = next.length !== records.length;
      if (detached) {
        if (next.length === 0) await bb.storage.kv.delete(key);
        else await bb.storage.kv.set(key, next);
        bb.realtime.publish("threads:changed", { taskId: input.taskId });
        bb.realtime.publish("tasks:changed", { taskId: input.taskId });
      }
      return { detached };
    },
    async listTaskThreadsForTasks(input) {
      const localTaskIds = input.taskIds.filter((taskId) =>
        Boolean(store.tasks.getTask(taskId)),
      );
      const externalTaskIds = input.taskIds.filter(
        (taskId) => !store.tasks.getTask(taskId),
      );
      const [localResult, externalResults] = await Promise.all([
        local.listTaskThreadsForTasks({ taskIds: localTaskIds }),
        Promise.all(
          externalTaskIds.map((taskId) =>
            handlers.listTaskThreads({ taskId }),
          ),
        ),
      ]);
      return {
        taskThreads: [
          ...localResult.taskThreads,
          ...externalResults.flatMap((result) => result.taskThreads),
        ],
      };
    },
    async listTaskPullRequests(input) {
      if (store.tasks.getTask(input.taskId)) return local.listTaskPullRequests(input);
      return { pullRequests: [], unavailableThreadIds: [] };
    },
    async sidebarSummary() {
      const localSummary = new Map(
        (await local.sidebarSummary(null)).projects.map((item) => [item.projectId, item]),
      );
      const projects = store.tasks.listProjects().map((project) => {
        const externalCount = externalTaskCounts.get(project.id);
        return externalCount === undefined
          ? (localSummary.get(project.id) ?? {
              projectId: project.id,
              taskCount: 0,
              activeTaskCount: 0,
              activeAgentCount: 0,
            })
          : {
              projectId: project.id,
              taskCount: externalCount,
              activeTaskCount: 0,
              activeAgentCount: 0,
            };
      });
      return { projects };
    },
  };
  bb.rpc.register(tasksRpcContract, handlers);

  bb.rpc.register(taskProvidersRpcContract, {
    async refreshExternalTaskSources() {
      // A browser reload or explicit UI refresh must be able to bypass the
      // short fallback cache used by remote sources such as Jira. Keep the
      // last known counts to avoid sidebar flicker while the fresh reads run.
      externalTasksCache.clear();
      return { ok: true as const };
    },
    async getProjectTaskProvider(input) {
      const project = store.tasks.getProject(input.projectId);
      if (!project) throw new Error(`Project not found: ${input.projectId}`);
      const resolved = await resolveProjectProvider(bb, settings, project);
      return {
        selected: resolved.selected,
        explicit: resolved.explicit,
        jiraJql: resolved.jiraJql,
        providers: resolved.providers,
      };
    },
    async setProjectTaskProvider(input) {
      const project = store.tasks.getProject(input.projectId);
      if (!project) throw new Error(`Project not found: ${input.projectId}`);
      const resolved = await resolveProjectProvider(bb, settings, project);
      const provider = resolved.providers.find((item) => item.id === input.provider);
      if (!provider?.available) throw new Error(`${provider?.name ?? input.provider} is not available`);
      await saveProjectProvider(bb, input.projectId, input.provider, input.jiraJql);
      invalidateExternalTasks(input.projectId);
      externalTaskCounts.delete(input.projectId);
      bb.realtime.publish("projects:changed", { projectId: input.projectId });
      bb.realtime.publish("tasks:changed", { projectId: input.projectId });
      return { ok: true as const };
    },
    async setBeadsTaskStatus(input) {
      const match = await findExternalInProject(
        input.projectId,
        (task) => task.id === input.taskId,
      );
      if (!match || match.source.id !== "beads")
        throw new Error(`Beads task not found: ${input.taskId}`);
      if (
        input.status === "in_progress" &&
        match.sourceTask.blockedByIds.length > 0
      ) {
        throw new Error(
          `${match.sourceTask.key} is blocked by ${match.sourceTask.blockedByIds.join(", ")}. Close or remove those dependencies before starting work.`,
        );
      }
      await match.source.update(match.sourceTask.id, {
        nativeStatus: input.status,
      });
      invalidateExternalTasks(match.projectId);
      bb.realtime.publish("tasks:changed", {
        taskId: match.task.id,
        projectId: match.projectId,
      });
      return { ok: true as const };
    },
    async listBeadsTaskLinks(input) {
      const match = await findExternalInProject(
        input.projectId,
        (task) => task.id === input.taskId,
      );
      if (!match || match.source.id !== "beads" || !match.source.listLinks)
        throw new Error(`Beads task not found: ${input.taskId}`);
      const links = await match.source.listLinks(match.sourceTask.id);
      const seen = new Set<string>();
      return {
        links: links.flatMap((link) => {
          if (!BEADS_LINK_TYPE_SET.has(link.type)) return [];
          const type = link.type as TaskLinkType;
          const linkedTaskId = syntheticUlid(match.projectId, link.task.id);
          const key = `${linkedTaskId}:${type}`;
          if (type === "relates-to" && seen.has(key)) return [];
          seen.add(key);
          return [
            {
              linkedTaskId,
              linkedTaskKey: link.task.key,
              linkedTaskTitle: link.task.title,
              linkedTaskStatus: link.task.nativeStatus,
              type,
              direction: link.direction,
            },
          ];
        }),
      };
    },
    async addBeadsTaskLink(input) {
      if (input.taskId === input.linkedTaskId)
        throw new Error("A task cannot link to itself");
      const [match, linked] = await Promise.all([
        findExternalInProject(
          input.projectId,
          (task) => task.id === input.taskId,
        ),
        findExternalInProject(
          input.projectId,
          (task) => task.id === input.linkedTaskId,
        ),
      ]);
      if (
        !match ||
        !linked ||
        match.projectId !== linked.projectId ||
        match.source.id !== "beads" ||
        !match.source.addLink
      )
        throw new Error("Both tasks must belong to the same Beads project");
      await match.source.addLink(
        match.sourceTask.id,
        linked.sourceTask.id,
        input.type,
      );
      invalidateExternalTasks(match.projectId);
      bb.realtime.publish("tasks:changed", {
        taskId: match.task.id,
        projectId: match.projectId,
      });
      return { ok: true as const };
    },
    async removeBeadsTaskLink(input) {
      const [match, linked] = await Promise.all([
        findExternalInProject(
          input.projectId,
          (task) => task.id === input.taskId,
        ),
        findExternalInProject(
          input.projectId,
          (task) => task.id === input.linkedTaskId,
        ),
      ]);
      if (
        !match ||
        !linked ||
        match.projectId !== linked.projectId ||
        match.source.id !== "beads" ||
        !match.source.removeLink
      )
        throw new Error("Both tasks must belong to the same Beads project");
      await match.source.removeLink(
        match.sourceTask.id,
        linked.sourceTask.id,
        input.type,
        input.direction,
      );
      invalidateExternalTasks(match.projectId);
      bb.realtime.publish("tasks:changed", {
        taskId: match.task.id,
        projectId: match.projectId,
      });
      return { ok: true as const };
    },
    async getTaskExecutionTargets(input) {
      const targets = await executionTargets(input.taskId, input.taskProjectId);
      const projects = await bb.sdk.projects.list({ includePersonal: false });
      return {
        selectedProjectIds: targets.projectIds,
        explicit: targets.explicit,
        projects: projects.map((project) => ({ id: project.id, name: project.name })),
      };
    },
    async setTaskExecutionTargets(input) {
      const unique = [...new Set(input.projectIds)];
      const projects = await bb.sdk.projects.list({ includePersonal: false });
      const available = new Set(projects.map((project) => project.id));
      const missing = unique.find((projectId) => !available.has(projectId));
      if (missing) throw new Error(`bb project not found: ${missing}`);
      await bb.storage.kv.set(targetsKey(input.taskId), unique);
      bb.realtime.publish("tasks:changed", { taskId: input.taskId });
      return { ok: true as const };
    },
    async dispatchTask(input) {
      const localTask = store.tasks.getTask(input.taskId);
      const external = localTask
        ? null
        : await findExternal((task) => task.id === input.taskId);
      const task = localTask ?? external?.task;
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      if (
        external?.source.id === "beads" &&
        (external.sourceTask.nativeStatus === "blocked" ||
          external.sourceTask.blockedByIds.length > 0)
      ) {
        const detail =
          external.sourceTask.blockedByIds.length > 0
            ? ` by ${external.sourceTask.blockedByIds.join(", ")}`
            : "";
        throw new Error(
          `${external.sourceTask.key} is blocked${detail}. Close or remove its blockers before dispatching.`,
        );
      }
      const taskProject = store.tasks.getProject(task.projectId);
      if (!taskProject) throw new Error(`Task project not found: ${task.projectId}`);
      const preset = store.tasks.getPreset(input.presetId);
      if (!preset) throw new Error(`Preset not found: ${input.presetId}`);
      const targets = await executionTargets(task.id, task.projectId);
      if (targets.projectIds.length === 0) {
        throw new Error("Choose at least one execution target for this task");
      }

      const environment =
        preset.environmentKind === "project-default"
          ? ({ type: "project-default" } as const)
          : ({
              type: "host" as const,
              hostId:
                preset.machineId ?? (await bb.sdk.system.config()).primaryHostId ?? "",
              workspace: {
                type: "managed-worktree" as const,
                baseBranch: preset.baseBranch
                  ? ({ kind: "named" as const, name: preset.baseBranch })
                  : ({ kind: "default" as const }),
              },
            } as const);
      if (environment.type === "host" && !environment.hostId) {
        throw new Error("BB has no default machine for a new worktree");
      }

      const title = `${task.key} · ${task.title}`.slice(0, 120);
      const sourceName = taskProject.name;
      const prompt = [
        `# ${task.key} · ${task.title}`,
        "## Description",
        task.description.trim() || "No description provided.",
        "## Task source",
        sourceName,
        preset.instructions.trim() ? `## Preset instructions\n\n${preset.instructions.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      const threadIds: string[] = [];
      for (const targetProjectId of targets.projectIds) {
        const thread = await bb.sdk.threads.spawn({
          projectId: targetProjectId,
          environment,
          providerId: preset.providerId,
          model: preset.modelId,
          reasoningLevel: preset.reasoningLevel as "low" | "medium" | "high" | "xhigh" | "max",
          permissionMode: preset.permissionMode,
          title,
          prompt,
        });
        threadIds.push(thread.id);
        const now = new Date().toISOString();
        if (localTask) {
          store.tasks.upsertTaskThread({
            taskId: task.id,
            threadId: thread.id,
            presetName: preset.name,
            title,
            liveStatus: "starting",
          });
        } else {
          const records =
            (await bb.storage.kv.get<ExternalThreadRecord[]>(externalThreadsKey(task.id))) ?? [];
          records.push({
            id: syntheticUlid(task.id, thread.id),
            taskId: task.id,
            threadId: thread.id,
            presetName: preset.name,
            title,
            liveStatus: "starting",
            attachedAt: now,
            updatedAt: now,
            targetProjectId,
          });
          await bb.storage.kv.set(externalThreadsKey(task.id), records);
        }
      }
      if (localTask && (localTask.status === "backlog" || localTask.status === "todo")) {
        store.tasks.updateTask(localTask.id, { status: "in_progress" });
      } else if (external && !external.readOnly) {
        await external.source.update(external.sourceTask.id, { status: "in_progress" });
      }
      bb.realtime.publish("threads:changed", { taskId: task.id });
      bb.realtime.publish("tasks:changed", { taskId: task.id, projectId: task.projectId });
      return { threadIds };
    },
  });

  return handlers;
}
