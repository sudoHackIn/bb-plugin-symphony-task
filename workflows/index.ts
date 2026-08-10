import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginRpcHandlers } from "@bb/plugin-sdk";
import { z } from "zod";
import type { TasksApiStore } from "../api/index.js";
import { workflowRpcContract } from "./contract.js";
import {
  initialOpenSpecState, reduceOpenSpec, type ArtifactReady, type OpenSpecSnapshot,
  type OpenSpecStage, type OpenSpecState, type WorkflowRunStatus,
} from "./openspec.js";

const DEFAULT_WORKFLOW_ID = "openspec";
const DEFAULT_WORKFLOW_REVISION = "1";
const artifactResultSchema = z.object({
  kind: z.literal("artifact_ready"), path: z.string().min(1).refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), "path must stay inside the workspace"),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), summary: z.string(),
  openQuestions: z.array(z.string()), evidence: z.array(z.string()),
}).strict();

export interface WorkflowBead {
  id: string; key: string; title: string; description: string; targetProjectId: string;
}
export interface WorkflowBeadsBridge {
  getBead(taskId: string, projectId: string): Promise<WorkflowBead>;
  setInProgress(taskId: string, projectId: string): Promise<void>;
}

interface RunRow {
  id: string; workflow_id: string; workflow_revision: string; tracker: "beads";
  project_id: string; work_item_id: string; work_item_key: string; work_item_title: string;
  environment_id: string | null; stage: OpenSpecStage; status: WorkflowRunStatus;
  state_json: string; version: number; created_at: string; updated_at: string;
}
interface EventRow { sequence: number; }
export interface OpenSpecRunView {
  id: string; workflowId: string; workflowRevision: string; tracker: "beads";
  projectId: string; workItemId: string; workItemKey: string; workItemTitle: string;
  environmentId: string | null; stage: OpenSpecStage; status: WorkflowRunStatus; version: number;
  activeThreadId: string | null; attempt: number; pendingReview: ArtifactReady | null;
  lastHumanComment: string | null; updatedAt: string;
}

const systemPrompt = `# OpenSpec workflow policy\n\nCreate a proposal artifact for this Bead. Do not change task status or advance the workflow. Your final response must be a single JSON object matching the runtime contract.`;
function now(): string { return new Date().toISOString(); }
function decode(row: RunRow): OpenSpecState { return JSON.parse(row.state_json) as OpenSpecState; }
function view(row: RunRow): OpenSpecRunView {
  const state = decode(row);
  return { id: row.id, workflowId: row.workflow_id, workflowRevision: row.workflow_revision,
    tracker: row.tracker, projectId: row.project_id, workItemId: row.work_item_id,
    workItemKey: row.work_item_key, workItemTitle: row.work_item_title,
    environmentId: row.environment_id, stage: row.stage, status: row.status, version: row.version,
    activeThreadId: state.activeThreadId, attempt: state.attempts.proposal ?? 1,
    pendingReview: state.pendingReview, lastHumanComment: state.lastHumanComment, updatedAt: row.updated_at };
}
function parseArtifact(output: string | null): ArtifactReady {
  if (!output) throw new Error("Proposal thread finished without an artifact_ready result");
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```\s*$/i)?.[1] ?? output.trim();
  const parsed = artifactResultSchema.safeParse(JSON.parse(fenced));
  if (!parsed.success) throw new Error(`Invalid artifact_ready result: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  return parsed.data;
}

export function registerOpenSpecWorkflow(
  bb: BbPluginApi, store: TasksApiStore, beads: WorkflowBeadsBridge,
): void {
  const db = store.database;
  const get = (id: string): RunRow | null => db.prepare<[string], RunRow>("SELECT * FROM workflow_runs WHERE id = ?").get(id) ?? null;
  const getByTask = (taskId: string): RunRow | null => db.prepare<[string], RunRow>(`SELECT * FROM workflow_runs WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1`).get(taskId) ?? null;
  const event = (runId: string, type: string, data: unknown) => {
    const sequence = (db.prepare<[string], EventRow>("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM workflow_events WHERE run_id = ?").get(runId)?.sequence ?? 1);
    db.prepare<[string, string, number, string, string, string]>("INSERT INTO workflow_events (id, run_id, sequence, type, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), runId, sequence, type, JSON.stringify(data), now());
  };
  const publish = (row: RunRow) => bb.realtime.publish("workflow:changed", { taskId: row.work_item_id, runId: row.id });
  const persist = (row: RunRow, snapshot: OpenSpecSnapshot, type: string, data: unknown, environmentId = row.environment_id): RunRow => {
    return store.transaction(() => {
      const updated = now();
      const changed = db.prepare<[string, WorkflowRunStatus, string, string | null, string, string]>(
        "UPDATE workflow_runs SET stage = ?, status = ?, state_json = ?, environment_id = ?, version = version + 1, updated_at = ? WHERE id = ?",
      ).run(snapshot.stage, snapshot.status, JSON.stringify(snapshot.state), environmentId, updated, row.id);
      if (changed.changes !== 1) throw new Error("Workflow run no longer exists");
      event(row.id, type, data);
      return get(row.id)!;
    });
  };
  const launchProposal = async (row: RunRow, bead: WorkflowBead, presetId: string): Promise<RunRow> => {
    const preset = store.tasks.getPreset(presetId);
    if (!preset) throw new Error(`Preset not found: ${presetId}`);
    const state = decode(row);
    const thread = await bb.sdk.threads.spawn({
      projectId: bead.targetProjectId, environment: { type: "project-default" }, providerId: preset.providerId,
      model: preset.modelId, reasoningLevel: preset.reasoningLevel as "low" | "medium" | "high" | "xhigh" | "max",
      permissionMode: preset.permissionMode, title: `${bead.key} · Proposal`,
      prompt: `${systemPrompt}\n\n## Bead\n${bead.key} · ${bead.title}\n\n${bead.description}\n\n## Runtime contract\nStage: PROPOSAL_DRAFTING\nAttempt: ${state.attempts.proposal ?? 1}\nWrite the artifact at a workspace-relative path. Compute its digest after writing with \`shasum -a 256 <path>\`, prefixed by \`sha256:\`.\nExpected output: {"kind":"artifact_ready","path":"...","digest":"sha256:<64 lowercase hex>","summary":"...","openQuestions":[],"evidence":[]}`,
    });
    const snapshot = reduceOpenSpec({ stage: row.stage, status: row.status, state }, { type: "stage_started", threadId: thread.id });
    const result = persist(row, snapshot, "stage_started", { stage: snapshot.stage, threadId: thread.id }, thread.environmentId);
    publish(result); return result;
  };
  const reconcile = async (row: RunRow): Promise<void> => {
    if (row.stage !== "PROPOSAL_DRAFTING" || row.status !== "waiting_agent") return;
    const threadId = decode(row).activeThreadId;
    if (!threadId) return;
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.status === "error") { event(row.id, "run_failed", { reason: "proposal thread failed" }); return; }
    if (thread.status !== "idle") return;
    const artifact = parseArtifact((await bb.sdk.threads.output({ threadId })).output);
    const current = get(row.id); if (!current || current.version !== row.version) return;
    const snapshot = reduceOpenSpec({ stage: current.stage, status: current.status, state: decode(current) }, { type: "artifact_ready", artifact });
    const result = persist(current, snapshot, "artifact_ready", artifact); publish(result);
  };
  const verifyArtifactDigest = async (row: RunRow, artifact: ArtifactReady): Promise<void> => {
    if (!row.environment_id) throw new Error("Proposal environment is missing; a new review is required");
    const environment = await bb.sdk.environments.get({ environmentId: row.environment_id });
    if (!environment.path) throw new Error("Proposal workspace is unavailable; a new review is required");
    const file = await bb.sdk.files.read({ hostId: environment.hostId, rootPath: environment.path, path: artifact.path });
    if (`sha256:${file.sha256}` !== artifact.digest) {
      throw new Error("The proposal artifact changed after it was submitted; a new review is required");
    }
  };

  const handlers: PluginRpcHandlers<typeof workflowRpcContract> = {
    async getWorkflowRun(input) { const row = getByTask(input.taskId); return { run: row ? view(row) : null }; },
    async startOpenSpecWorkflow(input) {
      const bead = await beads.getBead(input.taskId, input.projectId);
      let row: RunRow;
      try {
        row = store.transaction(() => {
          const active = db.prepare<[string, string], RunRow>("SELECT * FROM workflow_runs WHERE tracker = 'beads' AND project_id = ? AND work_item_id = ? AND status NOT IN ('completed', 'failed')").get(input.projectId, bead.id);
          if (active) throw new Error("This Bead already has an active OpenSpec workflow");
          const created = now(); const id = randomUUID();
          const initialState = initialOpenSpecState(); initialState.presetId = input.presetId;
          db.prepare("INSERT INTO workflow_runs (id, workflow_id, workflow_revision, tracker, project_id, work_item_id, work_item_key, work_item_title, stage, status, state_json, version, created_at, updated_at) VALUES (?, ?, ?, 'beads', ?, ?, ?, ?, 'PROPOSAL_DRAFTING', 'running', ?, 1, ?, ?)")
            .run(id, DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_REVISION, input.projectId, bead.id, bead.key, bead.title, JSON.stringify(initialState), created, created);
          event(id, "run_started", { workflowId: DEFAULT_WORKFLOW_ID, workflowRevision: DEFAULT_WORKFLOW_REVISION });
          return get(id)!;
        });
      } catch (error) { throw error; }
      await beads.setInProgress(input.taskId, input.projectId);
      return { run: view(await launchProposal(row, bead, input.presetId)) };
    },
    async resolveWorkflowGate(input) {
      const row = get(input.runId); if (!row) throw new Error("Workflow run not found");
      if (row.version !== input.expectedVersion) throw new Error("This review is stale; refresh before deciding");
      const state = decode(row); const artifact = state.artifacts.proposal;
      if (!artifact || artifact.digest !== state.pendingReview?.digest) throw new Error("The proposal changed; a new review is required");
      await verifyArtifactDigest(row, artifact);
      const snapshot = reduceOpenSpec({ stage: row.stage, status: row.status, state }, input.decision === "approve" ? { type: "approved", comment: input.comment } : { type: "changes_requested", comment: input.comment });
      const next = persist(row, snapshot, input.decision === "approve" ? "review_approved" : "changes_requested", { stage: row.stage, digest: artifact.digest, comment: input.comment });
      publish(next);
      if (input.decision === "request_changes") {
        const bead = await beads.getBead(row.work_item_id, row.project_id);
        return { run: view(await launchProposal(next, bead, decode(next).presetId ?? "")) };
      }
      return { run: view(next) };
    },
  };
  bb.rpc.register(workflowRpcContract, handlers);
  void (async () => { for (const row of db.prepare<[], RunRow>("SELECT * FROM workflow_runs WHERE status IN ('running', 'waiting_agent')").all()) { try { await reconcile(row); } catch (error) { bb.log.warn(`Could not reconcile OpenSpec run ${row.id}: ${error instanceof Error ? error.message : String(error)}`); } } })();
  bb.events.on("thread.idle", ({ thread }) => { const row = db.prepare<[string], RunRow>("SELECT * FROM workflow_runs WHERE json_extract(state_json, '$.activeThreadId') = ? AND status = 'waiting_agent'").get(thread.id); if (row) void reconcile(row); });
}
