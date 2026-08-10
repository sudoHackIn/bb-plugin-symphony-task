import { z } from "zod";
import { defineRpcContract } from "../rpc-runtime.js";

export const TASK_PROVIDER_IDS = ["local", "beads", "jira"] as const;
export type TaskProviderId = (typeof TASK_PROVIDER_IDS)[number];
export const BEADS_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
] as const;
export const BEADS_LINK_TYPES = ["blocks", "tracks", "relates-to"] as const;

const providerSchema = z
  .object({
    id: z.enum(TASK_PROVIDER_IDS),
    name: z.string(),
    available: z.boolean(),
    detail: z.string(),
    readOnly: z.boolean(),
  })
  .strict();

export const taskProvidersRpcContract = defineRpcContract({
  refreshExternalTaskSources: {
    input: z.null(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  getProjectTaskProvider: {
    input: z.object({ projectId: z.string() }).strict(),
    output: z
      .object({
        selected: z.enum(TASK_PROVIDER_IDS),
        explicit: z.boolean(),
        jiraJql: z.string(),
        providers: z.array(providerSchema),
      })
      .strict(),
  },
  setProjectTaskProvider: {
    input: z
      .object({
        projectId: z.string(),
        provider: z.enum(TASK_PROVIDER_IDS),
        jiraJql: z.string(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  getTaskExecutionTargets: {
    input: z
      .object({ taskId: z.string(), taskProjectId: z.string() })
      .strict(),
    output: z
      .object({
        selectedProjectIds: z.array(z.string().startsWith("proj_")),
        explicit: z.boolean(),
        projects: z.array(
          z.object({ id: z.string().startsWith("proj_"), name: z.string() }).strict(),
        ),
      })
      .strict(),
  },
  setTaskExecutionTargets: {
    input: z
      .object({
        taskId: z.string(),
        projectIds: z.array(z.string().startsWith("proj_")),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  dispatchTask: {
    input: z
      .object({
        taskId: z.string(),
        presetId: z.string(),
        // Omitted callers retain the preset instructions. Supplying an empty
        // string deliberately removes them for this dispatch only.
        instructions: z.string().optional(),
      })
      .strict(),
    output: z.object({ threadIds: z.array(z.string().startsWith("thr_")).min(1) }).strict(),
  },
  setBeadsTaskStatus: {
    input: z
      .object({
        taskId: z.string(),
        projectId: z.string(),
        status: z.enum(BEADS_STATUSES),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  listBeadsTaskLinks: {
    input: z.object({ taskId: z.string(), projectId: z.string() }).strict(),
    output: z
      .object({
        links: z.array(
          z
            .object({
              linkedTaskId: z.string(),
              linkedTaskKey: z.string(),
              linkedTaskTitle: z.string(),
              linkedTaskStatus: z.string(),
              type: z.enum(BEADS_LINK_TYPES),
              direction: z.enum(["down", "up"]),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  addBeadsTaskLink: {
    input: z
      .object({
        taskId: z.string(),
        projectId: z.string(),
        linkedTaskId: z.string(),
        type: z.enum(BEADS_LINK_TYPES),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  removeBeadsTaskLink: {
    input: z
      .object({
        taskId: z.string(),
        projectId: z.string(),
        linkedTaskId: z.string(),
        type: z.enum(BEADS_LINK_TYPES),
        direction: z.enum(["down", "up"]),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

export type TaskProvidersRpcContract = typeof taskProvidersRpcContract;
