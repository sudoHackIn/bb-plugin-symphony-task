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

export interface OpenSpecState {
  attempts: Record<string, number>;
  artifacts: Partial<Record<OpenSpecArtifact["stage"], OpenSpecArtifact>>;
  activeThreadId: string | null;
  lastHumanComment: string | null;
  pendingReview: ArtifactReady | null;
  presetId: string | null;
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

/** Pure reducer for the proposal gate; later stages deliberately remain typed. */
export function reduceOpenSpec(
  snapshot: OpenSpecSnapshot,
  event:
    | { type: "stage_started"; threadId: string }
    | { type: "artifact_ready"; artifact: ArtifactReady }
    | { type: "approved"; comment: string }
    | { type: "changes_requested"; comment: string },
): OpenSpecSnapshot {
  const state: OpenSpecState = structuredClone(snapshot.state);
  if (event.type === "stage_started") {
    if (snapshot.stage !== "PROPOSAL_DRAFTING") throw new Error("stage cannot be started");
    state.activeThreadId = event.threadId;
    return { stage: snapshot.stage, status: "waiting_agent", state };
  }
  if (event.type === "artifact_ready") {
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
    return { stage: "PROPOSAL_REVIEW", status: "waiting_human", state };
  }
  if (event.type === "approved") {
    if (snapshot.stage !== "PROPOSAL_REVIEW" || snapshot.status !== "waiting_human") throw new Error("approval is not expected");
    const proposal = state.artifacts.proposal;
    if (!proposal) throw new Error("proposal artifact is missing");
    proposal.approvedDigest = proposal.digest;
    state.pendingReview = null;
    state.lastHumanComment = event.comment || null;
    return { stage: "SPEC_DRAFTING", status: "running", state };
  }
  if (snapshot.stage !== "PROPOSAL_REVIEW" || snapshot.status !== "waiting_human") throw new Error("changes are not expected");
  state.attempts.proposal = (state.attempts.proposal ?? 1) + 1;
  delete state.artifacts.proposal;
  state.pendingReview = null;
  state.lastHumanComment = event.comment;
  return { stage: "PROPOSAL_DRAFTING", status: "running", state };
}
