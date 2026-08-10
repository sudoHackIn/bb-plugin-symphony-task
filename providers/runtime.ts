import { createHash } from "node:crypto";
import type { BbPluginApi, PluginSettingsHandle } from "@bb/plugin-sdk";
import type { Task, TaskPriority, TaskStatus } from "../shared/contract.js";
import { BeadsTaskSource, isBeadsCliAvailable, isBeadsWorkspace } from "../lib/beads-source.js";
import { JiraTaskSource } from "../lib/jira-source.js";
import type { TaskSource, UnifiedTask } from "../lib/task-source.js";
import type { TaskProviderId } from "./contract.js";

export const DEFAULT_JIRA_JQL = "ORDER BY updated DESC";
const BINDING_PREFIX = "task-provider:";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface ProviderSettings {
  beadsExecutable: string;
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraApiToken: string | undefined;
}

export interface ProjectProviderBinding {
  provider: TaskProviderId;
  jiraJql: string;
}

export interface ResolvedProjectProvider {
  selected: TaskProviderId;
  explicit: boolean;
  jiraJql: string;
  providers: Array<{
    id: TaskProviderId;
    name: string;
    available: boolean;
    detail: string;
    readOnly: boolean;
  }>;
  source: TaskSource | null;
}

export type ProviderSettingsHandle = PluginSettingsHandle<{
  beadsExecutable: { type: "string"; label: string; description: string; default: string };
  jiraBaseUrl: { type: "string"; label: string; default: string };
  jiraEmail: { type: "string"; label: string; default: string };
  jiraApiToken: { type: "string"; label: string; secret: true };
}>;

function bindingKey(projectId: string): string {
  return `${BINDING_PREFIX}${projectId}`;
}

export async function readProjectProviderBinding(
  bb: BbPluginApi,
  projectId: string,
): Promise<ProjectProviderBinding | null> {
  return (
    (await bb.storage.kv.get<ProjectProviderBinding>(bindingKey(projectId))) ??
    null
  );
}

async function beadsWorkspaceForProject(
  bb: BbPluginApi,
  linkedBbProjectId: string | null,
  executable: string,
): Promise<string | null> {
  if (!linkedBbProjectId || !(await isBeadsCliAvailable(executable))) return null;
  const project = await bb.sdk.projects.get({ projectId: linkedBbProjectId });
  const paths = project.sources
    .filter((source) => source.type === "local_path")
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
    .map((source) => source.path);
  for (const path of paths) {
    if (await isBeadsWorkspace(path, executable)) return path;
  }
  return null;
}

export async function resolveProjectProvider(
  bb: BbPluginApi,
  settingsHandle: ProviderSettingsHandle,
  project: { id: string; linkedBbProjectId: string | null },
): Promise<ResolvedProjectProvider> {
  const [settings, binding] = await Promise.all([
    settingsHandle.get(),
    bb.storage.kv.get<ProjectProviderBinding>(bindingKey(project.id)),
  ]);
  const workspace = await beadsWorkspaceForProject(
    bb,
    project.linkedBbProjectId,
    settings.beadsExecutable,
  );
  const jiraReady = Boolean(
    settings.jiraBaseUrl.trim() && settings.jiraEmail.trim() && settings.jiraApiToken,
  );
  const automatic: TaskProviderId = workspace ? "beads" : "local";
  const selected = binding?.provider ?? automatic;
  const jiraJql = binding?.jiraJql.trim() || DEFAULT_JIRA_JQL;
  let source: TaskSource | null = null;
  if (selected === "beads" && workspace) {
    source = new BeadsTaskSource(workspace, settings.beadsExecutable);
  } else if (selected === "jira" && jiraReady) {
    source = new JiraTaskSource(
      settings.jiraBaseUrl,
      settings.jiraEmail,
      settings.jiraApiToken!,
      jiraJql,
    );
  }
  return {
    selected,
    explicit: binding !== undefined,
    jiraJql,
    source,
    providers: [
      {
        id: "local",
        name: "Local Tasks",
        available: true,
        detail: "Stored by this plugin",
        readOnly: false,
      },
      {
        id: "beads",
        name: "Beads",
        available: workspace !== null,
        detail: workspace ?? "Link a bb project containing a Beads workspace",
        readOnly: false,
      },
      {
        id: "jira",
        name: "Jira",
        available: jiraReady,
        detail: jiraReady ? settings.jiraBaseUrl : "Configure Jira in plugin settings",
        readOnly: true,
      },
    ],
  };
}

export async function saveProjectProvider(
  bb: BbPluginApi,
  projectId: string,
  provider: TaskProviderId,
  jiraJql: string,
): Promise<void> {
  await bb.storage.kv.set(bindingKey(projectId), {
    provider,
    jiraJql: jiraJql.trim() || DEFAULT_JIRA_JQL,
  } satisfies ProjectProviderBinding);
}

export function syntheticUlid(projectId: string, nativeId: string): string {
  const bytes = createHash("sha256").update(`${projectId}\0${nativeId}`).digest();
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 26) {
      output += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${CROCKFORD.indexOf(output[0]!) % 8}${output.slice(1, 26)}`;
}

function officialStatus(status: UnifiedTask["status"]): TaskStatus {
  if (status === "in_progress") return "in_progress";
  if (status === "in_review") return "in_review";
  if (status === "done") return "done";
  if (status === "blocked") return "todo";
  return "backlog";
}

export function sourceStatus(status: TaskStatus): UnifiedTask["status"] {
  if (status === "in_progress") return "in_progress";
  if (status === "in_review") return "in_review";
  if (status === "done" || status === "canceled") return "done";
  return "backlog";
}

function positiveNumber(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0) || 1;
}

export function providerTask(projectId: string, task: UnifiedTask, position: number): Task {
  return {
    id: syntheticUlid(projectId, task.id),
    projectId,
    number: positiveNumber(task.id),
    key: task.key,
    title: task.title,
    description: task.description,
    status: officialStatus(task.status),
    priority: task.priority as TaskPriority,
    dueDate: null,
    parentTaskId:
      task.parentId === null ? null : syntheticUlid(projectId, task.parentId),
    position,
    createdAt: task.updatedAt,
    updatedAt: task.updatedAt,
    labelIds: [],
    sourceLabels: task.labels,
    sourceId: task.sourceId as "beads" | "jira",
    nativeStatus: task.nativeStatus,
    blockedByTaskIds: task.blockedByIds.map((id) =>
      syntheticUlid(projectId, id),
    ),
  };
}

export function findProviderTask(
  projectId: string,
  tasks: UnifiedTask[],
  syntheticId: string,
): UnifiedTask | undefined {
  return tasks.find((task) => syntheticUlid(projectId, task.id) === syntheticId);
}
