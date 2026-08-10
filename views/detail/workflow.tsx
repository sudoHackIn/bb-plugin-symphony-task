import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { Task, Preset } from "../../shared/contract.js";
import type { WorkflowRpcContract } from "../../workflows/contract.js";
import type { OpenSpecRunView } from "../../workflows/index.js";
import { Button } from "@/components/ui/button";

function stageName(stage: string) { return stage.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()); }

export function WorkflowPanel({ task, presets, onError }: { task: Task; presets: Preset[]; onError: (message: string) => void }) {
  const rpc = useRpc<WorkflowRpcContract>();
  const [current, setCurrent] = useState<OpenSpecRunView | null | undefined>(undefined);
  const refresh = useCallback(() => {
    void rpc.call("getWorkflowRun", { taskId: task.id }).then((result) => setCurrent(result.run), (error: unknown) => onError(error instanceof Error ? error.message : String(error)));
  }, [rpc, task.id, onError]);
  useEffect(() => { refresh(); }, [refresh]);
  useRealtime("workflow:changed", refresh);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    const preset = presets[0];
    if (!preset) return onError("Create an agent preset before starting OpenSpec");
    setBusy(true);
    try { await rpc.call("startOpenSpecWorkflow", { taskId: task.id, projectId: task.projectId, presetId: preset.id }); refresh(); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const resolve = async (decision: "approve" | "request_changes") => {
    if (!current) return;
    if (decision === "request_changes" && !comment.trim()) return onError("A comment is required when requesting changes");
    setBusy(true);
    try { await rpc.call("resolveWorkflowGate", { runId: current.id, expectedVersion: current.version, decision, comment: comment.trim() }); setComment(""); refresh(); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (current === undefined) return null;
  if (!current) return task.sourceId === "beads" ? <section className="mt-6 rounded-md border border-border p-3"><div className="text-sm font-medium">OpenSpec workflow</div><p className="mt-1 text-xs text-muted-foreground">Starts a durable proposal and human-review gate for this Bead.</p><Button className="mt-3" size="sm" disabled={busy} onClick={() => void start()}>Start proposal</Button></section> : null;
  const review = current.status === "waiting_human" && current.pendingReview;
  return <section className="mt-6 rounded-md border border-border p-3" aria-label="OpenSpec workflow">
    <div className="flex items-center justify-between gap-2"><div className="text-sm font-medium">OpenSpec workflow</div><span className="text-xs text-muted-foreground">Attempt {current.attempt}</span></div>
    <p className="mt-1 text-xs text-muted-foreground">Stage: {stageName(current.stage)} · {current.status.replaceAll("_", " ")}</p>
    {review ? <div className="mt-3 space-y-2 text-sm"><a className="block truncate text-primary underline" href={`file://${review.path}`}>{review.path}</a><div className="font-mono text-xs text-muted-foreground">{review.digest}</div><p>{review.summary}</p>{review.openQuestions.length ? <p className="text-xs text-muted-foreground">Open questions: {review.openQuestions.join(" · ")}</p> : null}<textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Comment (required for changes)" className="min-h-16 w-full rounded border border-input bg-background p-2 text-sm" /><div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void resolve("approve")}>Approve</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void resolve("request_changes")}>Request changes</Button></div></div> : null}
  </section>;
}
