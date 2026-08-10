import { z } from "zod";
import { defineRpcContract } from "../rpc-runtime.js";
import { OPENSPEC_STAGES, WORKFLOW_RUN_STATUSES } from "./openspec.js";

const artifactSchema = z.object({
  kind: z.literal("artifact_ready"), path: z.string(), digest: z.string(),
  summary: z.string(), openQuestions: z.array(z.string()), evidence: z.array(z.string()),
}).strict();
const runSchema = z.object({
  id: z.string(), workflowId: z.string(), workflowRevision: z.string(), tracker: z.literal("beads"),
  projectId: z.string(), workItemId: z.string(), workItemKey: z.string(), workItemTitle: z.string(),
  environmentId: z.string().nullable(), stage: z.enum(OPENSPEC_STAGES), status: z.enum(WORKFLOW_RUN_STATUSES),
  version: z.number().int().positive(), activeThreadId: z.string().nullable(), attempt: z.number().int().positive(),
  pendingReview: artifactSchema.nullable(), lastHumanComment: z.string().nullable(), updatedAt: z.string(),
  approvedArtifacts: z.array(artifactSchema.extend({ stage: z.enum(["proposal", "specs", "design", "tasks"]), attempt: z.number().int().positive(), approvedDigest: z.string().nullable() })),
  agentReview: z.object({ passed: z.boolean(), findings: z.array(z.string()), evidence: z.array(z.string()) }).nullable(),
  stageThreads: z.array(z.object({ stage: z.enum(OPENSPEC_STAGES), threadId: z.string() }).strict()),
}).strict();

export const workflowRpcContract = defineRpcContract({
  listWorkflowSummaries: { input: z.object({ taskIds: z.array(z.string()).max(500) }).strict(), output: z.object({ workflows: z.array(z.object({ taskId: z.string(), status: z.enum(WORKFLOW_RUN_STATUSES), stage: z.enum(OPENSPEC_STAGES) }).strict()) }).strict() },
  getProjectOpenSpecWorkflow: { input: z.object({ projectId: z.string() }).strict(), output: z.object({ workflowId: z.string(), revision: z.string(), markdown: z.string() }).strict() },
  updateProjectOpenSpecWorkflow: { input: z.object({ projectId: z.string(), markdown: z.string().min(1) }).strict(), output: z.object({ workflowId: z.string(), revision: z.string(), markdown: z.string() }).strict() },
  getWorkflowArtifactPreview: { input: z.object({ runId: z.string(), path: z.string() }).strict(), output: z.object({ url: z.string().min(1) }).strict() },
  getWorkflowArtifactContent: { input: z.object({ runId: z.string(), path: z.string() }).strict(), output: z.object({ markdown: z.string() }).strict() },
  getWorkflowRun: { input: z.object({ taskId: z.string() }).strict(), output: z.object({ run: runSchema.nullable() }).strict() },
  startOpenSpecWorkflow: { input: z.object({ taskId: z.string(), projectId: z.string(), presetId: z.string() }).strict(), output: z.object({ run: runSchema }).strict() },
  resolveWorkflowGate: { input: z.object({ runId: z.string(), expectedVersion: z.number().int().positive(), decision: z.enum(["approve", "request_changes"]), comment: z.string() }).strict(), output: z.object({ run: runSchema }).strict() },
});
export type WorkflowRpcContract = typeof workflowRpcContract;
