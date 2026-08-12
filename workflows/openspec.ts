/** The canonical OpenSpec state machine. Markdown supplies guidance, never transitions. */
export const OPENSPEC_STAGES = [
  "PROPOSAL_DRAFTING",
  "PROPOSAL_REVIEW",
  "SPEC_DRAFTING",
  "SPEC_REVIEW",
  "DESIGN_DRAFTING",
  "DESIGN_REVIEW",
  "TASKS_DRAFTING",
  "TASKS_REVIEW",
  "IMPLEMENTING",
  "AGENT_REVIEW",
  "FINAL_REVIEW",
  "DONE",
] as const;
export type OpenSpecStage = (typeof OPENSPEC_STAGES)[number];

export const WORKFLOW_RUN_STATUSES = [
  "running",
  "waiting_agent",
  "waiting_human",
  "completed",
  "failed",
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export interface ArtifactReady {
  kind: "artifact_ready";
  path: string;
  digest: string;
  summary: string;
  openQuestions: string[];
  evidence: string[];
}

export interface OpenSpecArtifact extends ArtifactReady {
  stage: "proposal" | "specs" | "design" | "tasks";
  attempt: number;
  approvedDigest: string | null;
}

export interface OpenSpecPresetIds {
  drafting: string;
  apply: string;
  review: string;
}

export interface OpenSpecState {
  attempts: Record<string, number>;
  artifacts: Partial<Record<OpenSpecArtifact["stage"], OpenSpecArtifact>>;
  activeThreadId: string | null;
  lastHumanComment: string | null;
  pendingReview: ArtifactReady | null;
  /** @deprecated Retained to resume workflow runs created before role presets. */
  presetId: string | null;
  presetIds: OpenSpecPresetIds | null;
  implementation: ArtifactReady | null;
  agentReview: { passed: boolean; findings: string[]; evidence: string[] } | null;
  workflowMarkdown: string;
}

export interface OpenSpecSnapshot {
  stage: OpenSpecStage;
  status: WorkflowRunStatus;
  state: OpenSpecState;
}

export function initialOpenSpecState(): OpenSpecState {
  return {
    attempts: { proposal: 1 },
    artifacts: {},
    activeThreadId: null,
    lastHumanComment: null,
    pendingReview: null,
    presetId: null,
    presetIds: null,
    implementation: null,
    agentReview: null,
    workflowMarkdown: "",
  };
}

export function draftArtifactName(stage: OpenSpecStage): OpenSpecArtifact["stage"] | null {
  switch (stage) {
    case "PROPOSAL_DRAFTING": return "proposal";
    case "SPEC_DRAFTING": return "specs";
    case "DESIGN_DRAFTING": return "design";
    case "TASKS_DRAFTING": return "tasks";
    default: return null;
  }
}

export function reviewStageFor(artifact: OpenSpecArtifact["stage"]): OpenSpecStage {
  const map: Record<OpenSpecArtifact["stage"], OpenSpecStage> = { proposal: "PROPOSAL_REVIEW", specs: "SPEC_REVIEW", design: "DESIGN_REVIEW", tasks: "TASKS_REVIEW" };
  return map[artifact];
}

export function draftStageFor(artifact: OpenSpecArtifact["stage"]): OpenSpecStage {
  const map: Record<OpenSpecArtifact["stage"], OpenSpecStage> = { proposal: "PROPOSAL_DRAFTING", specs: "SPEC_DRAFTING", design: "DESIGN_DRAFTING", tasks: "TASKS_DRAFTING" };
  return map[artifact];
}

export function reviewArtifactName(stage: OpenSpecStage): OpenSpecArtifact["stage"] | null {
  return ({ PROPOSAL_REVIEW: "proposal", SPEC_REVIEW: "specs", DESIGN_REVIEW: "design", TASKS_REVIEW: "tasks" } as Partial<Record<OpenSpecStage, OpenSpecArtifact["stage"]>>)[stage] ?? null;
}

export function downstreamArtifacts(artifact: OpenSpecArtifact["stage"]): OpenSpecArtifact["stage"][] {
  const map: Record<OpenSpecArtifact["stage"], OpenSpecArtifact["stage"][]> = { proposal: ["specs", "design", "tasks"], specs: ["design", "tasks"], design: ["tasks"], tasks: [] };
  return map[artifact];
}

/** Canonical fixed-graph reducer; Markdown policy cannot create transitions. */
export function reduceOpenSpec(
  snapshot: OpenSpecSnapshot,
  event:
    | { type: "stage_started"; threadId: string }
    | { type: "artifact_ready"; artifact: ArtifactReady }
    | { type: "agent_review"; passed: boolean; findings: string[]; evidence: string[]; maxImplementationAttempts: number }
    | { type: "approved"; comment: string }
    | { type: "changes_requested"; comment: string },
): OpenSpecSnapshot {
  const state: OpenSpecState = structuredClone(snapshot.state);
  if (event.type === "stage_started") {
    if ((!draftArtifactName(snapshot.stage) && snapshot.stage !== "IMPLEMENTING" && snapshot.stage !== "AGENT_REVIEW") || snapshot.status !== "running") throw new Error("stage cannot be started");
    state.activeThreadId = event.threadId;
    return { stage: snapshot.stage, status: "waiting_agent", state };
  }
  if (event.type === "artifact_ready") {
    if (snapshot.stage === "IMPLEMENTING" && snapshot.status === "waiting_agent") {
      state.implementation = event.artifact;
      state.activeThreadId = null;
      return { stage: "AGENT_REVIEW", status: "running", state };
    }
    const artifactName = draftArtifactName(snapshot.stage);
    if (!artifactName || snapshot.status !== "waiting_agent") throw new Error("artifact is not expected");
    state.artifacts[artifactName] = {
      ...event.artifact,
      stage: artifactName,
      attempt: state.attempts[artifactName] ?? 1,
      approvedDigest: null,
    };
    state.activeThreadId = null;
    state.pendingReview = event.artifact;
    return { stage: reviewStageFor(artifactName), status: "waiting_human", state };
  }
  if (event.type === "agent_review") {
    if (snapshot.stage !== "AGENT_REVIEW" || snapshot.status !== "waiting_agent") throw new Error("agent review is not expected");
    state.activeThreadId = null;
    state.agentReview = { passed: event.passed, findings: event.findings, evidence: event.evidence };
    if (event.passed) {
      state.pendingReview = state.implementation;
      return { stage: "FINAL_REVIEW", status: "waiting_human", state };
    }
    state.lastHumanComment = event.findings.join("\n");
    const currentAttempt = state.attempts.implementation ?? 1;
    if (currentAttempt >= event.maxImplementationAttempts) {
      state.pendingReview = state.implementation;
      return { stage: "FINAL_REVIEW", status: "waiting_human", state };
    }
    state.attempts.implementation = currentAttempt + 1;
    return { stage: "IMPLEMENTING", status: "running", state };
  }
  if (event.type === "approved") {
    if (snapshot.stage === "FINAL_REVIEW" && snapshot.status === "waiting_human") {
      state.lastHumanComment = event.comment || null;
      return { stage: "DONE", status: "completed", state };
    }
    const artifactName = reviewArtifactName(snapshot.stage);
    if (!artifactName || snapshot.status !== "waiting_human") throw new Error("approval is not expected");
    const artifact = state.artifacts[artifactName];
    if (!artifact) throw new Error("review artifact is missing");
    artifact.approvedDigest = artifact.digest;
    state.pendingReview = null;
    state.lastHumanComment = event.comment || null;
    const next = ({ proposal: "SPEC_DRAFTING", specs: "DESIGN_DRAFTING", design: "TASKS_DRAFTING", tasks: "IMPLEMENTING" })[artifactName] as OpenSpecStage;
    return { stage: next, status: "running", state };
  }
  const artifactName = reviewArtifactName(snapshot.stage);
  if (snapshot.stage === "FINAL_REVIEW" && snapshot.status === "waiting_human") {
    state.attempts.implementation = (state.attempts.implementation ?? 1) + 1;
    state.lastHumanComment = event.comment;
    state.pendingReview = null;
    state.agentReview = null;
    return { stage: "IMPLEMENTING", status: "running", state };
  }
  if (!artifactName || snapshot.status !== "waiting_human") throw new Error("changes are not expected");
  state.attempts[artifactName] = (state.attempts[artifactName] ?? 1) + 1;
  delete state.artifacts[artifactName];
  for (const dependent of downstreamArtifacts(artifactName)) delete state.artifacts[dependent];
  state.pendingReview = null;
  state.lastHumanComment = event.comment;
  return { stage: draftStageFor(artifactName), status: "running", state };
}
