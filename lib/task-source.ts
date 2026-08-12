export const TASK_STATUSES = [
  "backlog",
  "in_progress",
  "in_review",
  "blocked",
  "done",
] as const;

export const TASK_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface TaskSourceDescriptor {
  id: string;
  name: string;
  kind: "beads" | "jira";
  configured: boolean;
  detail: string | null;
  capabilities: {
    create: boolean;
    update: boolean;
    sync: boolean;
  };
}

export interface UnifiedTask {
  id: string;
  sourceId: string;
  key: string;
  title: string;
  description: string;
  status: TaskStatus;
  nativeStatus: string;
  priority: TaskPriority;
  type: string;
  labels: string[];
  assignee: string | null;
  externalRef: string | null;
  parentId: string | null;
  blockedByIds: string[];
  updatedAt: string;
  readOnly: boolean;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  type?: string;
  parentId?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  parentId?: string | null;
  nativeStatus?: string;
}

export interface UnifiedComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export type TaskLinkType = "blocks" | "tracks" | "relates-to";

export interface UnifiedTaskLink {
  direction: "down" | "up";
  type: string;
  task: UnifiedTask;
}

export interface TaskSource {
  readonly id: string;
  /** Cheap content fingerprint for cache validation. Sources without one use
   * a short TTL fallback. */
  revision?(): Promise<string>;
  list(): Promise<UnifiedTask[]>;
  create(input: CreateTaskInput): Promise<UnifiedTask>;
  update(id: string, input: UpdateTaskInput): Promise<UnifiedTask>;
  /** Optional native comment support. Sources that omit these methods are
   * exposed as comment-read-only in the shared task detail UI. */
  listComments?(id: string): Promise<UnifiedComment[]>;
  addComment?(
    id: string,
    body: string,
    author: string,
  ): Promise<UnifiedComment>;
  /** Optional provider-native metadata used for compact machine checkpoints. */
  getMetadata?(id: string, key: string): Promise<string | null>;
  setMetadata?(id: string, key: string, value: string | null): Promise<void>;
  listLinks?(id: string): Promise<UnifiedTaskLink[]>;
  addLink?(id: string, linkedId: string, type: TaskLinkType): Promise<void>;
  removeLink?(
    id: string,
    linkedId: string,
    type: TaskLinkType,
    direction: "down" | "up",
  ): Promise<void>;
}
