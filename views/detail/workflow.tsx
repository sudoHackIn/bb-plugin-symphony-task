import { useCallback, useEffect, useState } from "react";
import { Markdown, useBbNavigate, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { Task } from "../../shared/contract.js";
import type { WorkflowRpcContract } from "../../workflows/contract.js";
import type { OpenSpecRunView } from "../../workflows/index.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

function stageName(stage: string) { return stage.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()); }

const WORKFLOW_PHASES = [
  { label: "Proposal", stages: ["PROPOSAL_DRAFTING", "PROPOSAL_REVIEW"] },
  { label: "Specification", stages: ["SPEC_DRAFTING", "SPEC_REVIEW"] },
  { label: "Design", stages: ["DESIGN_DRAFTING", "DESIGN_REVIEW"] },
  { label: "Tasks", stages: ["TASKS_DRAFTING", "TASKS_REVIEW"] },
  { label: "Implementation", stages: ["IMPLEMENTING", "AGENT_REVIEW"] },
  { label: "Final review", stages: ["FINAL_REVIEW"] },
] as const;

function phaseIndex(stage: OpenSpecRunView["stage"]): number {
  if (stage === "DONE") return WORKFLOW_PHASES.length;
  return WORKFLOW_PHASES.findIndex((phase) =>
    (phase.stages as readonly string[]).includes(stage),
  );
}

function currentPhaseLabel(run: OpenSpecRunView): string {
  if (run.status === "failed") return "Needs attention";
  if (run.stage === "DONE") return "Complete";
  if (run.status === "waiting_human") {
    return run.stage === "FINAL_REVIEW" ? "Waiting for final approval" : "Waiting for approval";
  }
  if (run.stage === "AGENT_REVIEW") return "Independent agent review";
  return run.status === "waiting_agent" ? "Agent working" : "Ready to start";
}

function WorkflowProgress({ run }: { run: OpenSpecRunView }) {
  const navigate = useBbNavigate();
  const activeIndex = phaseIndex(run.stage);
  const completed = run.stage === "DONE" ? WORKFLOW_PHASES.length : Math.max(0, activeIndex);
  return (
    <div className="mt-3 rounded-md border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon name="GitBranch" className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1">OpenSpec workflow</span>
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", run.status === "completed" ? "bg-success/15 text-success" : run.status === "waiting_human" ? "bg-warning/15 text-warning" : "bg-secondary text-muted-foreground")}>{currentPhaseLabel(run)}</span>
      </div>
      <div className="mt-3 grid grid-cols-6 gap-1" aria-label={`${completed} of ${WORKFLOW_PHASES.length} workflow phases complete`}>
        {WORKFLOW_PHASES.map((phase, index) => (
          <span key={phase.label} title={`${phase.label}: ${index < completed || run.stage === "DONE" ? "complete" : index === activeIndex ? currentPhaseLabel(run) : "not started"}`} className={cn("h-1 rounded-full", index < completed || run.stage === "DONE" ? "bg-success" : index === activeIndex ? (run.status === "failed" ? "bg-destructive" : "bg-primary") : "bg-muted")} />
        ))}
      </div>
      <div className="mt-3 space-y-1.5">
        {WORKFLOW_PHASES.map((phase, index) => {
          const done = index < completed || run.stage === "DONE";
          const current = index === activeIndex && run.stage !== "DONE";
          const threads = run.stageThreads.filter((thread) => (phase.stages as readonly string[]).includes(thread.stage));
          return <div key={phase.label} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"><span className={cn("flex size-4 items-center justify-center rounded-full border", done ? "border-success bg-success/10 text-success" : current ? "border-primary text-primary" : "border-border text-muted-foreground")}>{done ? <Icon name="Check" className="size-3" /> : current ? <span className="size-1.5 rounded-full bg-current" /> : null}</span><span className={cn("flex-1", current && "font-medium")}>{phase.label}</span><span className={cn("text-muted-foreground", current && run.status === "waiting_human" && "text-warning")}>{done ? "Complete" : current ? currentPhaseLabel(run) : "Not started"}</span>{threads.map((thread, threadIndex) => <button key={thread.threadId} type="button" onClick={() => navigate.toThread(thread.threadId)} className="ml-6 flex items-center gap-1 text-primary hover:underline">{stageName(thread.stage)}{threads.length > 1 ? ` · ${threadIndex + 1}` : ""}<Icon name="ArrowUpRight" className="size-3" /></button>)}</div>;
        })}
      </div>
    </div>
  );
}

export function WorkflowPanel({ task, onError }: { task: Task; onError: (message: string) => void }) {
  const rpc = useRpc<WorkflowRpcContract>();
  const [current, setCurrent] = useState<OpenSpecRunView | null | undefined>(undefined);
  const refresh = useCallback(() => {
    void rpc.call("getWorkflowRun", { taskId: task.id }).then((result) => setCurrent(result.run), (error: unknown) => onError(error instanceof Error ? error.message : String(error)));
  }, [rpc, task.id, onError]);
  useEffect(() => { refresh(); }, [refresh]);
  useRealtime("workflow:changed", refresh);
  const [comment, setComment] = useState("");
  const [preview, setPreview] = useState<{ path: string; markdown: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const resolve = async (decision: "approve" | "request_changes") => {
    if (!current) return;
    if (decision === "request_changes" && !comment.trim()) return onError("A comment is required when requesting changes");
    setBusy(true);
    try { await rpc.call("resolveWorkflowGate", { runId: current.id, expectedVersion: current.version, decision, comment: comment.trim() }); setComment(""); refresh(); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const openArtifact = async (path: string) => {
    if (!current) return;
    try { const { markdown } = await rpc.call("getWorkflowArtifactContent", { runId: current.id, path }); setPreview({ path, markdown }); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  };
  if (current === undefined) return null;
  if (!current) return null;
  const review = current.status === "waiting_human" && current.pendingReview;
  return <><section className="mt-6" aria-label="OpenSpec workflow">
    <WorkflowProgress run={current} />
    <p className="mt-2 text-xs text-muted-foreground">Stage: {stageName(current.stage)} · attempt {current.attempt}</p>
    {current.stage === "FINAL_REVIEW" ? <div className="mt-3 space-y-2 text-xs"><div className="font-medium">Evidence package</div>{current.approvedArtifacts.map((artifact) => <div key={artifact.stage} className="rounded bg-muted p-2"><span className="font-medium">{artifact.stage}</span> · {artifact.path}<br /><span className="font-mono text-muted-foreground">{artifact.approvedDigest}</span></div>)}{current.agentReview ? <div className="rounded bg-muted p-2"><span className="font-medium">Agent review: {current.agentReview.passed ? "PASS" : "NEEDS CHANGES"}</span>{current.agentReview.findings.map((finding) => <div key={finding}>• {finding}</div>)}{current.agentReview.evidence.map((item) => <div key={item} className="text-muted-foreground">{item}</div>)}</div> : null}</div> : null}
    {review ? <div className="mt-3 space-y-2 text-sm"><button type="button" className="block max-w-full truncate text-primary underline" onClick={() => void openArtifact(review.path)}>{review.path}</button><div className="font-mono text-xs text-muted-foreground">{review.digest}</div><p>{review.summary}</p>{review.openQuestions.length ? <p className="text-xs text-muted-foreground">Open questions: {review.openQuestions.join(" · ")}</p> : null}<textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Comment (required for changes)" className="min-h-16 w-full rounded border border-input bg-background p-2 text-sm" /><div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void resolve("approve")}>Approve</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void resolve("request_changes")}>Request changes</Button></div></div> : null}
  </section><Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null); }}><DialogContent className="fixed inset-y-0 right-0 left-auto h-dvh w-[min(42rem,94vw)] max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none p-0"><DialogHeader className="border-b px-5 py-4 pr-12"><DialogTitle className="truncate">{preview?.path}</DialogTitle></DialogHeader>{preview ? <div className="min-h-0 overflow-y-auto px-6 py-5"><Markdown content={preview.markdown} /></div> : null}</DialogContent></Dialog></>;
}
