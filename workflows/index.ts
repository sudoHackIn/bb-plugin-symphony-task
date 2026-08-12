import { createHash, randomUUID } from "node:crypto";
import type { BbPluginApi, PluginRpcHandlers } from "@bb/plugin-sdk";
import { z } from "zod";
import type { TasksApiStore } from "../api/index.js";
import { workflowCheckpointSchema, workflowRpcContract, type WorkflowCheckpoint } from "./contract.js";
import {
  draftArtifactName, downstreamArtifacts, initialOpenSpecState, reduceOpenSpec, reviewArtifactName, type ArtifactReady, type OpenSpecPresetIds, type OpenSpecSnapshot,
  type OpenSpecArtifact, type OpenSpecStage, type OpenSpecState, type WorkflowRunStatus,
} from "./openspec.js";

const DEFAULT_WORKFLOW_ID = "openspec";
const DEFAULT_WORKFLOW_REVISION = "1";
const DEFAULT_WORKFLOW_MARKDOWN = `# OpenSpec workflow\n\n## Drafting\nCreate the requested artifact using approved inputs.\n\n## AGENT_REVIEW\nReview independently against the approved artifacts and report only actionable findings.\n\n## FINAL_REVIEW\nPresent verified evidence, remaining risks, and migration impact.`;
const artifactResultSchema = z.object({
  kind: z.literal("artifact_ready"), path: z.string().min(1).refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), "path must stay inside the workspace"),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), summary: z.string(),
  openQuestions: z.array(z.string()), evidence: z.array(z.string()),
}).strict();
const TRANSFERABLE_STAGES = new Set<OpenSpecStage>([
  "PROPOSAL_REVIEW", "SPEC_REVIEW", "DESIGN_REVIEW", "TASKS_REVIEW", "FINAL_REVIEW",
]);

export interface WorkflowBead {
  id: string; key: string; title: string; description: string; targetProjectId: string;
}
export interface WorkflowBeadsBridge {
  getBead(taskId: string, projectId: string): Promise<WorkflowBead>;
  setInProgress(taskId: string, projectId: string): Promise<void>;
  setDone(taskId: string, projectId: string): Promise<void>;
  attachWorkflowThread(
    taskId: string,
    projectId: string,
    threadId: string,
    stage: OpenSpecStage,
  ): Promise<void>;
  loadCheckpoint(taskId: string, projectId: string): Promise<string | null>;
  saveCheckpoint(taskId: string, projectId: string, checkpoint: string): Promise<void>;
}

interface RunRow {
  id: string; workflow_id: string; workflow_revision: string; tracker: "beads";
  project_id: string; work_item_id: string; work_item_key: string; work_item_title: string;
  environment_id: string | null; stage: OpenSpecStage; status: WorkflowRunStatus;
  state_json: string; version: number; created_at: string; updated_at: string;
}
interface EventRow { sequence: number; }
interface DefinitionRow { id: string; revision: string; markdown: string; }
export interface OpenSpecRunView {
  id: string; workflowId: string; workflowRevision: string; tracker: "beads";
  projectId: string; workItemId: string; workItemKey: string; workItemTitle: string;
  environmentId: string | null; stage: OpenSpecStage; status: WorkflowRunStatus; version: number;
  activeThreadId: string | null; attempt: number; pendingReview: ArtifactReady | null;
  lastHumanComment: string | null; updatedAt: string;
  approvedArtifacts: OpenSpecArtifact[];
  agentReview: OpenSpecState["agentReview"];
  stageThreads: Array<{ stage: OpenSpecStage; threadId: string }>;
}

const systemPrompt = `# OpenSpec workflow policy\n\nEach worker run is limited to one workflow stage. Work only on the current stage's requested artifact. Do not create, draft, modify, regenerate, or validate artifacts for an earlier or later OpenSpec phase, including already approved artifacts. Do not change task status or advance the workflow. Submit only the required JSON result; the workflow orchestrator starts the next stage only after human approval.`;
function now(): string { return new Date().toISOString(); }
function decode(row: RunRow): OpenSpecState { return JSON.parse(row.state_json) as OpenSpecState; }
function view(
  row: RunRow,
  stageThreads: Array<{ stage: OpenSpecStage; threadId: string }> = [],
): OpenSpecRunView {
  const state = decode(row);
  return { id: row.id, workflowId: row.workflow_id, workflowRevision: row.workflow_revision,
    tracker: row.tracker, projectId: row.project_id, workItemId: row.work_item_id,
    workItemKey: row.work_item_key, workItemTitle: row.work_item_title,
    environmentId: row.environment_id, stage: row.stage, status: row.status, version: row.version,
    activeThreadId: state.activeThreadId, attempt: state.attempts[
      row.stage === "IMPLEMENTING" || row.stage === "AGENT_REVIEW" || row.stage === "FINAL_REVIEW"
        ? "implementation"
        : draftArtifactName(row.stage) ?? reviewArtifactName(row.stage) ?? "proposal"
    ] ?? 1,
    pendingReview: state.pendingReview, lastHumanComment: state.lastHumanComment, updatedAt: row.updated_at,
    approvedArtifacts: Object.values(state.artifacts).filter((artifact): artifact is OpenSpecArtifact => artifact !== undefined), agentReview: state.agentReview, stageThreads };
}
function structuredJson(output: string | null): unknown {
  if (!output) throw new Error("Thread finished without a structured result");
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = (fenced ?? output).trim();
  if (!source.startsWith("{")) return JSON.parse(source);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return JSON.parse(source.slice(0, index + 1));
  }
  return JSON.parse(source);
}
function parseArtifact(output: string | null): ArtifactReady {
  const parsed = artifactResultSchema.safeParse(structuredJson(output));
  if (!parsed.success) throw new Error(`Invalid artifact_ready result: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  return parsed.data;
}
function parseJsonOutput(output: string | null): unknown {
  return structuredJson(output);
}

export function registerOpenSpecWorkflow(
  bb: BbPluginApi,
  store: TasksApiStore,
  beads: WorkflowBeadsBridge,
  options: { maxImplementationAttempts(): Promise<number> },
): void {
  const db = store.database;
  const checkpointFor = async (row: RunRow): Promise<WorkflowCheckpoint> => {
    if (row.status !== "waiting_human" || !TRANSFERABLE_STAGES.has(row.stage)) {
      throw new Error("Workflow checkpoints can only be exported while waiting at a human review gate");
    }
    if (!row.environment_id) throw new Error("Workflow checkout is unavailable");
    const state = decode(row);
    if (!state.pendingReview) throw new Error("Workflow review artifact is missing");
    const environmentStatus = await bb.sdk.environments.status({ environmentId: row.environment_id });
    if (environmentStatus.outcome !== "available") throw new Error("Workflow Git checkout is unavailable");
    if (environmentStatus.workspace.workingTree.hasUncommittedChanges) {
      throw new Error("Commit all workflow changes before exporting a checkpoint");
    }
    const checkout = environmentStatus.workspace.checkout;
    const commit = checkout.kind === "branch" || checkout.kind === "detached" ? checkout.headSha : null;
    if (!commit) throw new Error("Workflow checkout has no Git commit to transfer");
    const presetIds = state.presetIds ?? (state.presetId
      ? { drafting: state.presetId, apply: state.presetId, review: state.presetId }
      : null);
    if (!presetIds) throw new Error("Workflow presets are unavailable");
    const presetNames = Object.fromEntries(Object.entries(presetIds).map(([role, id]) => {
      const preset = store.tasks.getPreset(id);
      if (!preset) throw new Error(`Workflow preset not found: ${id}`);
      return [role, preset.name];
    })) as WorkflowCheckpoint["presetNames"];
    return workflowCheckpointSchema.parse({
      formatVersion: 1,
      taskId: row.work_item_id,
      taskKey: row.work_item_key,
      taskTitle: row.work_item_title,
      workflowId: row.workflow_id,
      workflowRevision: row.workflow_revision,
      workflowMarkdown: state.workflowMarkdown,
      stage: row.stage,
      attempts: state.attempts,
      artifacts: state.artifacts,
      pendingReview: state.pendingReview,
      lastHumanComment: state.lastHumanComment,
      implementation: state.implementation,
      agentReview: state.agentReview,
      presetNames,
      git: { branch: checkout.kind === "branch" ? checkout.branchName : null, commit },
      exportedAt: now(),
    });
  };
  const projectArtifact = async (projectId: string, path: string) => {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find((candidate) => candidate.isDefault) ?? project.sources[0];
    if (!source) throw new Error("Target project has no workspace source");
    const file = await bb.sdk.projects.fileContent({ projectId, hostId: source.hostId, path });
    const bytes = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
    return { content: file.contentEncoding === "utf8" ? file.content : bytes.toString("utf8"), digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  };
  const definitionForProject = (projectId: string): DefinitionRow => {
    db.prepare("INSERT OR IGNORE INTO workflow_definitions (id, revision, markdown, created_at) VALUES (?, ?, ?, ?)")
      .run(DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_REVISION, DEFAULT_WORKFLOW_MARKDOWN, now());
    const row = db.prepare<[string], DefinitionRow>(`SELECT d.id, d.revision, d.markdown FROM project_workflow_bindings b JOIN workflow_definitions d ON d.id = b.workflow_id AND d.revision = b.workflow_revision WHERE b.project_id = ?`).get(projectId);
    return row ?? db.prepare<[string, string], DefinitionRow>("SELECT id, revision, markdown FROM workflow_definitions WHERE id = ? AND revision = ?").get(DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_REVISION)!;
  };
  const get = (id: string): RunRow | null => db.prepare<[string], RunRow>("SELECT * FROM workflow_runs WHERE id = ?").get(id) ?? null;
  const stageThreadsFor = (runId: string): Array<{ stage: OpenSpecStage; threadId: string }> =>
    db.prepare<[string], { data_json: string }>("SELECT data_json FROM workflow_events WHERE run_id = ? AND type = 'stage_started' ORDER BY sequence").all(runId).flatMap((event) => {
      try {
        const data = JSON.parse(event.data_json) as { stage?: unknown; threadId?: unknown };
        return typeof data.stage === "string" && typeof data.threadId === "string" ? [{ stage: data.stage as OpenSpecStage, threadId: data.threadId }] : [];
      } catch { return []; }
    });
  const runView = (row: RunRow): OpenSpecRunView => view(row, stageThreadsFor(row.id));
  const getByTask = (taskId: string): RunRow | null => db.prepare<[string], RunRow>(`SELECT * FROM workflow_runs WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1`).get(taskId) ?? null;
  const event = (runId: string, type: string, data: unknown) => {
    const sequence = (db.prepare<[string], EventRow>("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM workflow_events WHERE run_id = ?").get(runId)?.sequence ?? 1);
    db.prepare<[string, string, number, string, string, string]>("INSERT INTO workflow_events (id, run_id, sequence, type, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), runId, sequence, type, JSON.stringify(data), now());
  };
  const publish = (row: RunRow) => bb.realtime.publish("workflow:changed", { taskId: row.work_item_id, runId: row.id });
  const fail = (row: RunRow, reason: string) => {
    const state = decode(row); state.activeThreadId = null;
    const result = persist(row, { stage: row.stage, status: "failed", state }, "run_failed", { reason });
    publish(result);
  };
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
  const launchStage = async (row: RunRow, bead: WorkflowBead): Promise<RunRow> => {
    const state = decode(row);
    const artifactName = draftArtifactName(row.stage);
    const role: keyof OpenSpecPresetIds = artifactName ? "drafting" : row.stage === "AGENT_REVIEW" ? "review" : "apply";
    const presetId = state.presetIds?.[role] ?? state.presetId;
    if (!presetId) throw new Error(`OpenSpec ${role} preset is missing`);
    const preset = store.tasks.getPreset(presetId);
    if (!preset) throw new Error(`Preset not found: ${presetId}`);
    if (!artifactName && row.stage !== "IMPLEMENTING" && row.stage !== "AGENT_REVIEW") throw new Error(`Cannot launch a worker for ${row.stage}`);
    const approvedInputs = Object.values(state.artifacts)
      .filter((artifact) => artifact?.approvedDigest)
      .map((artifact) => `- ${artifact!.stage}: ${artifact!.path} (${artifact!.approvedDigest})`)
      .join("\n") || "None.";
    const attempt = state.attempts[artifactName ?? "implementation"] ?? 1;
    const stageScope = artifactName
      ? attempt === 1
        ? `Current artifact: ${artifactName}. Run \`openspec next\` exactly once to generate this current artifact, then create or edit only that artifact. Do not use \`openspec next\` again to generate another document.`
        : `Current artifact: ${artifactName}. Its output is the only OpenSpec artifact you may create or edit in this run.`
      : "Current stage: implementation. Work only on the approved implementation tasks; do not create or edit any OpenSpec artifacts.";
    const reworkInstruction = artifactName && attempt > 1
      ? `This is rework for ${artifactName}. Do not run \`openspec next\`: it would generate the following document. Apply the human review context only to the existing ${artifactName} artifact, then submit it for another review. Do not advance, initiate, or prepare any other phase.`
      : "";
    const thread = await bb.sdk.threads.spawn({
      projectId: bead.targetProjectId, environment: row.environment_id ? { type: "reuse", environmentId: row.environment_id } : { type: "project-default" }, providerId: preset.providerId,
      model: preset.modelId, reasoningLevel: preset.reasoningLevel as "low" | "medium" | "high" | "xhigh" | "max",
      permissionMode: preset.permissionMode,
      title: `OpenSpec workflow · OpenSpec ${artifactName ?? (row.stage === "AGENT_REVIEW" ? "review" : "implementation")}`.slice(0, 120),
      prompt: row.stage === "AGENT_REVIEW"
        ? `# Independent OpenSpec review\n\n${systemPrompt}\n\n${state.workflowMarkdown}\n\nReview only the implementation independently; you have no implementer conversation history.\n\n## Approved OpenSpec\n${approvedInputs}\n\nReturn only JSON: {"passed":true,"findings":[],"evidence":["tests/diff examined"]} or {"passed":false,"findings":["severity: requirement: expected fix"],"evidence":[]}.`
        : `${systemPrompt}\n\n${state.workflowMarkdown}\n\n## Bead\n${bead.key} · ${bead.title}\n\n${bead.description}\n\n## Approved inputs\n${approvedInputs}\n\n## Current stage scope\n${stageScope}\n\n## Last human review context\n${state.lastHumanComment ?? "None."}\n\n${reworkInstruction ? `## Rework scope\n${reworkInstruction}\n\n` : ""}## Runtime contract\nStage: ${row.stage}\nAttempt: ${attempt}\n${row.stage === "IMPLEMENTING" ? "Implement the approved tasks and report verification." : `Write the ${artifactName} artifact at a workspace-relative path.`} Compute a digest with \`shasum -a 256 <path>\`, prefixed by \`sha256:\`.\nExpected output: {"kind":"artifact_ready","path":"...","digest":"sha256:<64 lowercase hex>","summary":"...","openQuestions":[],"evidence":[]}`,
    });
    // Provisioning can finish after spawn responds; read the thread once so
    // the run owns the actual environment before any later stage reuses it.
    const spawnedThread = await bb.sdk.threads.get({ threadId: thread.id });
    const environmentId = spawnedThread.environmentId ?? thread.environmentId;
    if (!environmentId) throw new Error("BB created a workflow thread without an environment");
    await beads.attachWorkflowThread(bead.id, row.project_id, thread.id, row.stage);
    const snapshot = reduceOpenSpec({ stage: row.stage, status: row.status, state }, { type: "stage_started", threadId: thread.id });
    const result = persist(row, snapshot, "stage_started", { stage: snapshot.stage, threadId: thread.id }, environmentId);
    publish(result); return result;
  };
  const reconcile = async (row: RunRow): Promise<void> => {
    if ((!draftArtifactName(row.stage) && row.stage !== "IMPLEMENTING" && row.stage !== "AGENT_REVIEW") || row.status !== "waiting_agent") return;
    const threadId = decode(row).activeThreadId;
    if (!threadId) return;
    const thread = await bb.sdk.threads.get({ threadId });
    await beads.attachWorkflowThread(row.work_item_id, row.project_id, threadId, row.stage);
    let expectedVersion = row.version;
    if (row.environment_id === null && thread.environmentId) {
      const repaired = persist(row, { stage: row.stage, status: row.status, state: decode(row) }, "environment_recovered", { threadId, environmentId: thread.environmentId }, thread.environmentId);
      expectedVersion = repaired.version;
    }
    if (thread.status === "error") { fail(row, `${row.stage} thread failed`); return; }
    if (thread.status !== "idle") return;
    const current = get(row.id); if (!current || current.version !== expectedVersion) return;
    const output = (await bb.sdk.threads.output({ threadId })).output;
    if (current.stage === "AGENT_REVIEW") {
      const review = z.object({ passed: z.boolean(), findings: z.array(z.string()), evidence: z.array(z.string()) }).strict().parse(parseJsonOutput(output));
      const snapshot = reduceOpenSpec(
        { stage: current.stage, status: current.status, state: decode(current) },
        { type: "agent_review", ...review, maxImplementationAttempts: await options.maxImplementationAttempts() },
      );
      const result = persist(current, snapshot, review.passed ? "agent_review_passed" : "agent_review_findings", review); publish(result);
      if (!review.passed && result.stage === "IMPLEMENTING") {
        const bead = await beads.getBead(current.work_item_id, current.project_id);
        await launchStage(result, bead);
      }
      return;
    }
    const artifact = parseArtifact(output);
    const snapshot = reduceOpenSpec({ stage: current.stage, status: current.status, state: decode(current) }, { type: "artifact_ready", artifact });
    const result = persist(current, snapshot, "artifact_ready", artifact); publish(result);
    if (result.stage === "AGENT_REVIEW") { const bead = await beads.getBead(current.work_item_id, current.project_id); await launchStage(result, bead); }
  };
  const verifyArtifactDigest = async (row: RunRow, artifact: ArtifactReady): Promise<void> => {
    let environmentId = row.environment_id;
    if (!environmentId) {
      const started = db.prepare<[string], { data_json: string }>("SELECT data_json FROM workflow_events WHERE run_id = ? AND type = 'stage_started' ORDER BY sequence DESC LIMIT 1").get(row.id);
      const threadId = started ? (JSON.parse(started.data_json) as { threadId?: string }).threadId : undefined;
      if (threadId) environmentId = (await bb.sdk.threads.get({ threadId })).environmentId;
      if (!environmentId) {
        const bead = await beads.getBead(row.work_item_id, row.project_id);
        const file = await projectArtifact(bead.targetProjectId, artifact.path);
        if (file.digest !== artifact.digest) {
          throw new Error(`The reviewed artifact does not match the transferred checkpoint: ${artifact.path}.`);
        }
        return;
      }
      persist(row, { stage: row.stage, status: row.status, state: decode(row) }, "environment_recovered", { threadId, environmentId }, environmentId);
    }
    const environment = await bb.sdk.environments.get({ environmentId });
    if (!environment.path) throw new Error("Artifact workspace is unavailable; a new review is required");
    const file = await bb.sdk.files.read({
      hostId: environment.hostId,
      rootPath: environment.path,
      path: `${environment.path}/${artifact.path}`,
    });
    if (`sha256:${file.sha256}` !== artifact.digest) {
      throw new Error(`The reviewed artifact changed after it was submitted: ${artifact.path}. A new review is required.`);
    }
  };

  const handlers: PluginRpcHandlers<typeof workflowRpcContract> = {
    async listWorkflowSummaries(input) {
      if (input.taskIds.length === 0) return { workflows: [] };
      const placeholders = input.taskIds.map(() => "?").join(",");
      const rows = db.prepare<string[], { work_item_id: string; status: WorkflowRunStatus; stage: OpenSpecStage }>(`SELECT work_item_id, status, stage FROM workflow_runs WHERE work_item_id IN (${placeholders}) AND status NOT IN ('completed','failed')`).all(...input.taskIds);
      return { workflows: rows.map((row) => ({ taskId: row.work_item_id, status: row.status, stage: row.stage })) };
    },
    async getProjectOpenSpecWorkflow(input) { const definition = definitionForProject(input.projectId); return { workflowId: definition.id, revision: definition.revision, markdown: definition.markdown }; },
    async updateProjectOpenSpecWorkflow(input) {
      const revision = `${Date.now()}`;
      store.transaction(() => {
        db.prepare("INSERT INTO workflow_definitions (id, revision, markdown, created_at) VALUES (?, ?, ?, ?)").run(DEFAULT_WORKFLOW_ID, revision, input.markdown, now());
        db.prepare("INSERT INTO project_workflow_bindings (project_id, workflow_id, workflow_revision, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET workflow_id = excluded.workflow_id, workflow_revision = excluded.workflow_revision, updated_at = excluded.updated_at").run(input.projectId, DEFAULT_WORKFLOW_ID, revision, now());
      });
      return { workflowId: DEFAULT_WORKFLOW_ID, revision, markdown: input.markdown };
    },
    async getWorkflowArtifactPreview(input) {
      const row = get(input.runId);
      if (!row || !row.environment_id) throw new Error("Workflow artifact environment is unavailable");
      const state = decode(row);
      const paths = [
        ...Object.values(state.artifacts).flatMap((artifact) => artifact ? [artifact.path] : []),
        ...(state.implementation ? [state.implementation.path] : []),
      ];
      if (!paths.includes(input.path)) throw new Error("Artifact does not belong to this workflow run");
      const environment = await bb.sdk.environments.get({ environmentId: row.environment_id });
      if (!environment.path) throw new Error("Workflow workspace is unavailable");
      const preview = await bb.sdk.files.createPreview({ rootPath: environment.path, ttlMs: 60_000 });
      return { url: `${preview.baseUrl}/${input.path.split("/").map(encodeURIComponent).join("/")}` };
    },
    async getWorkflowArtifactContent(input) {
      const row = get(input.runId);
      if (!row) throw new Error("Workflow run not found");
      const state = decode(row);
      const paths = [...Object.values(state.artifacts).flatMap((artifact) => artifact ? [artifact.path] : []), ...(state.implementation ? [state.implementation.path] : [])];
      if (!paths.includes(input.path)) throw new Error("Artifact does not belong to this workflow run");
      if (!row.environment_id) {
        const bead = await beads.getBead(row.work_item_id, row.project_id);
        return { markdown: (await projectArtifact(bead.targetProjectId, input.path)).content };
      }
      const environment = await bb.sdk.environments.get({ environmentId: row.environment_id });
      if (!environment.path) throw new Error("Workflow workspace is unavailable");
      const file = await bb.sdk.files.read({ hostId: environment.hostId, rootPath: environment.path, path: `${environment.path}/${input.path}` });
      return { markdown: file.content };
    },
    async getWorkflowRun(input) { const row = getByTask(input.taskId); return { run: row ? runView(row) : null }; },
    async getWorkflowCheckpoint(input) {
      const raw = await beads.loadCheckpoint(input.taskId, input.projectId);
      return { checkpoint: raw ? workflowCheckpointSchema.parse(JSON.parse(raw)) : null };
    },
    async exportWorkflowCheckpoint(input) {
      const row = get(input.runId);
      if (!row) throw new Error("Workflow run not found");
      if (row.version !== input.expectedVersion) throw new Error("Workflow changed; refresh before exporting");
      const checkpoint = await checkpointFor(row);
      const serialized = JSON.stringify(checkpoint);
      if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new Error("Workflow checkpoint exceeds the 64 KB transfer limit");
      await beads.saveCheckpoint(row.work_item_id, row.project_id, serialized);
      event(row.id, "checkpoint_exported", { stage: row.stage, commit: checkpoint.git.commit, exportedAt: checkpoint.exportedAt });
      return { checkpoint };
    },
    async resumeWorkflowCheckpoint(input) {
      const active = db.prepare<[string, string], RunRow>("SELECT * FROM workflow_runs WHERE tracker = 'beads' AND project_id = ? AND work_item_id = ? AND status NOT IN ('completed', 'failed')").get(input.projectId, input.taskId);
      if (active) throw new Error("This Beads task already has an active local workflow");
      const raw = await beads.loadCheckpoint(input.taskId, input.projectId);
      if (!raw) throw new Error("This Beads task has no workflow checkpoint");
      const checkpoint = workflowCheckpointSchema.parse(JSON.parse(raw));
      if (checkpoint.taskId !== input.taskId) throw new Error("Workflow checkpoint belongs to a different Beads task");
      const bead = await beads.getBead(input.taskId, input.projectId);
      const targetProject = await bb.sdk.projects.get({ projectId: bead.targetProjectId });
      const source = targetProject.sources.find((candidate) => candidate.isDefault) ?? targetProject.sources[0];
      if (!source) throw new Error("Target project has no workspace source");
      const branches = await bb.sdk.projects.branches({ projectId: bead.targetProjectId, hostId: source.hostId });
      const headSha = branches.checkout.kind === "branch" || branches.checkout.kind === "detached" ? branches.checkout.headSha : null;
      if (headSha !== checkpoint.git.commit) {
        throw new Error(`Target project must be checked out at checkpoint commit ${checkpoint.git.commit}`);
      }
      const reviewFile = await projectArtifact(bead.targetProjectId, checkpoint.pendingReview.path);
      if (reviewFile.digest !== checkpoint.pendingReview.digest) {
        throw new Error(`Checkpoint artifact digest does not match the target checkout: ${checkpoint.pendingReview.path}`);
      }
      const availablePresets = store.tasks.listPresets();
      const presetId = (role: keyof OpenSpecPresetIds): string => {
        const name = checkpoint.presetNames[role];
        const preset = availablePresets.find((candidate) => candidate.name === name);
        if (!preset) throw new Error(`Create or rename a local preset to match checkpoint role ${role}: ${name}`);
        return preset.id;
      };
      const presetIds: OpenSpecPresetIds = { drafting: presetId("drafting"), apply: presetId("apply"), review: presetId("review") };
      const state: OpenSpecState = {
        attempts: checkpoint.attempts,
        artifacts: checkpoint.artifacts,
        activeThreadId: null,
        lastHumanComment: checkpoint.lastHumanComment,
        pendingReview: checkpoint.pendingReview,
        presetId: null,
        presetIds,
        implementation: checkpoint.implementation,
        agentReview: checkpoint.agentReview,
        workflowMarkdown: checkpoint.workflowMarkdown,
      };
      const created = now();
      const id = randomUUID();
      const row = store.transaction(() => {
        db.prepare("INSERT OR IGNORE INTO workflow_definitions (id, revision, markdown, created_at) VALUES (?, ?, ?, ?)").run(checkpoint.workflowId, checkpoint.workflowRevision, checkpoint.workflowMarkdown, created);
        db.prepare("INSERT INTO workflow_runs (id, workflow_id, workflow_revision, tracker, project_id, work_item_id, work_item_key, work_item_title, environment_id, stage, status, state_json, version, created_at, updated_at) VALUES (?, ?, ?, 'beads', ?, ?, ?, ?, NULL, ?, 'waiting_human', ?, 1, ?, ?)")
          .run(id, checkpoint.workflowId, checkpoint.workflowRevision, input.projectId, bead.id, bead.key, bead.title, checkpoint.stage, JSON.stringify(state), created, created);
        event(id, "checkpoint_resumed", { stage: checkpoint.stage, commit: checkpoint.git.commit, exportedAt: checkpoint.exportedAt });
        return get(id)!;
      });
      publish(row);
      return { run: runView(row) };
    },
    async startOpenSpecWorkflow(input) {
      const bead = await beads.getBead(input.taskId, input.projectId);
      const definition = definitionForProject(input.projectId);
      let row: RunRow;
      try {
        row = store.transaction(() => {
          const active = db.prepare<[string, string], RunRow>("SELECT * FROM workflow_runs WHERE tracker = 'beads' AND project_id = ? AND work_item_id = ? AND status NOT IN ('completed', 'failed')").get(input.projectId, bead.id);
          if (active) throw new Error("This Bead already has an active OpenSpec workflow");
          const created = now(); const id = randomUUID();
          const initialState = initialOpenSpecState(); initialState.presetIds = input.presetIds; initialState.workflowMarkdown = definition.markdown;
          db.prepare("INSERT INTO workflow_runs (id, workflow_id, workflow_revision, tracker, project_id, work_item_id, work_item_key, work_item_title, stage, status, state_json, version, created_at, updated_at) VALUES (?, ?, ?, 'beads', ?, ?, ?, ?, 'PROPOSAL_DRAFTING', 'running', ?, 1, ?, ?)")
            .run(id, definition.id, definition.revision, input.projectId, bead.id, bead.key, bead.title, JSON.stringify(initialState), created, created);
          event(id, "run_started", { workflowId: definition.id, workflowRevision: definition.revision });
          return get(id)!;
        });
      } catch (error) { throw error; }
      await beads.setInProgress(input.taskId, input.projectId);
      return { run: runView(await launchStage(row, bead)) };
    },
    async resolveWorkflowGate(input) {
      const row = get(input.runId); if (!row) throw new Error("Workflow run not found");
      if (row.version !== input.expectedVersion) throw new Error("This review is stale; refresh before deciding");
      const state = decode(row); const artifactName = reviewArtifactName(row.stage); const artifact = artifactName ? state.artifacts[artifactName] : row.stage === "FINAL_REVIEW" ? state.implementation : null;
      if (!artifact || artifact.digest !== state.pendingReview?.digest) {
        throw new Error("The reviewed artifact changed before this decision; refresh and review the current version.");
      }
      await verifyArtifactDigest(row, artifact);
      const snapshot = reduceOpenSpec({ stage: row.stage, status: row.status, state }, input.decision === "approve" ? { type: "approved", comment: input.comment } : { type: "changes_requested", comment: input.comment });
      const next = persist(row, snapshot, input.decision === "approve" ? "review_approved" : "changes_requested", { stage: row.stage, digest: artifact.digest, comment: input.comment });
      publish(next);
      if (next.stage === "DONE") await beads.setDone(row.work_item_id, row.project_id);
      if (input.decision === "request_changes" && artifactName) {
        for (const dependent of downstreamArtifacts(artifactName)) event(next.id, "stage_invalidated", { stage: dependent, cause: artifactName });
      }
      if (input.decision === "request_changes") {
        const bead = await beads.getBead(row.work_item_id, row.project_id);
        return { run: runView(await launchStage(next, bead)) };
      }
      if (draftArtifactName(next.stage) || next.stage === "IMPLEMENTING") {
        const bead = await beads.getBead(row.work_item_id, row.project_id);
        return { run: runView(await launchStage(next, bead)) };
      }
      return { run: runView(next) };
    },
  };
  bb.rpc.register(workflowRpcContract, handlers);
  void (async () => { for (const row of db.prepare<[], RunRow>("SELECT * FROM workflow_runs WHERE status = 'waiting_agent'").all()) { try { await reconcile(row); } catch (error) { bb.log.warn(`Could not reconcile OpenSpec run ${row.id}: ${error instanceof Error ? error.message : String(error)}`); } } })();
  bb.events.on("thread.idle", ({ thread }) => { const row = db.prepare<[string], RunRow>("SELECT * FROM workflow_runs WHERE json_extract(state_json, '$.activeThreadId') = ? AND status = 'waiting_agent'").get(thread.id); if (row) void reconcile(row); });
}
