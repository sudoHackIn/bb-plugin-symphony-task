import { z } from "zod";
import { defineRpcContract } from "../rpc-runtime.js";
import {
  EXECUTION_LABEL_MATCHES,
  EXECUTION_PROJECT_MODES,
  EXECUTION_RUN_STATUSES,
  TASK_EXECUTION_POLICIES,
} from "./types.js";

const positiveWorkerCount = z.number().int().min(1).max(32);
const tokenBudget = z.number().int().min(1_000).nullable();
const projectMode = z.enum(EXECUTION_PROJECT_MODES);
const labelMatch = z.enum(EXECUTION_LABEL_MATCHES);
const taskPolicy = z.enum(TASK_EXECUTION_POLICIES);
const runStatus = z.enum(EXECUTION_RUN_STATUSES);

const configSchema = z
  .object({
    enabled: z.boolean(),
    maxWorkers: positiveWorkerCount,
    pollIntervalSeconds: z.number().int().min(5).max(3_600),
    defaultTokenBudget: tokenBudget,
    maxAttempts: z.number().int().min(1).max(20),
    updatedAt: z.string(),
  })
  .strict();

const projectPolicySchema = z
  .object({
    projectId: z.string(),
    mode: projectMode,
    presetId: z.string().nullable(),
    maxWorkers: positiveWorkerCount.nullable(),
    tokenBudget,
    labelFilter: z.array(z.string().min(1)).max(100),
    labelMatch,
    updatedAt: z.string(),
  })
  .strict();

const runSchema = z
  .object({
    id: z.string(),
    tracker: z.enum(["local", "beads", "jira"]),
    projectId: z.string(),
    workItemId: z.string(),
    taskKey: z.string(),
    taskTitle: z.string(),
    externalVersion: z.string(),
    threadId: z.string().startsWith("thr_").nullable(),
    claimId: z.string(),
    claimExpiresAt: z.string().nullable(),
    status: runStatus,
    attempt: z.number().int().positive(),
    presetId: z.string().nullable(),
    tokenBudget,
    tokensUsed: z.number().int().nonnegative(),
    lastEventSeq: z.number().int().nonnegative(),
    error: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .strict();

export const executionRpcContract = defineRpcContract({
  getExecutionDashboard: {
    input: z.null(),
    output: z
      .object({
        config: configSchema,
        activeWorkers: z.number().int().nonnegative(),
        projects: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              source: z.enum(["local", "beads", "jira", "automatic"]),
              supported: z.boolean(),
              supportDetail: z.string(),
              labels: z.array(
                z.object({ value: z.string(), name: z.string() }).strict(),
              ),
              policy: projectPolicySchema,
            })
            .strict(),
        ),
        presets: z.array(
          z.object({ id: z.string(), name: z.string() }).strict(),
        ),
        tasks: z.array(
          z
            .object({
              id: z.string(),
              tracker: z.enum(["local", "beads", "jira"]),
              projectId: z.string(),
              key: z.string(),
              title: z.string(),
              labels: z.array(z.string()),
              policy: taskPolicy,
              latestStatus: runStatus.nullable(),
              latestAttempt: z.number().int().positive().nullable(),
            })
            .strict(),
        ),
        runs: z.array(runSchema),
      })
      .strict(),
  },
  updateExecutionConfig: {
    input: configSchema.omit({ updatedAt: true }).strict(),
    output: z.object({ config: configSchema }).strict(),
  },
  setProjectExecutionPolicy: {
    input: projectPolicySchema.omit({ updatedAt: true }).strict(),
    output: z.object({ policy: projectPolicySchema }).strict(),
  },
  setTaskExecutionPolicy: {
    input: z
      .object({
        tracker: z.enum(["local", "beads", "jira"]),
        projectId: z.string(),
        workItemId: z.string(),
        policy: taskPolicy,
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  stopExecutionRun: {
    input: z.object({ runId: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  retryExecutionRun: {
    input: z.object({ runId: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

export type ExecutionRpcContract = typeof executionRpcContract;
