import { useState } from "react";
import type { DisplayComment, Task } from "../../shared/contract.js";
import { useMentionItems, useTasksQuery, useTasksRpc } from "../../shell/data.js";
import { TasksEditor } from "../../editor/tasks-editor.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";

function latestReviewUpdate(
  comments: readonly DisplayComment[],
): DisplayComment | undefined {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (!comment || comment.kind === "system") continue;
    if (
      comment.kind === "agent" ||
      comment.authorName === "Execution agent" ||
      comment.authorName === "Symphony Task"
    ) {
      return comment;
    }
  }
  return [...comments].reverse().find((comment) => comment.kind !== "system");
}

export function ReviewPanel({
  task,
  agentBusy,
  onError,
}: {
  task: Task;
  agentBusy: boolean;
  onError: (message: string) => void;
}) {
  const rpc = useTasksRpc();
  const mentionItems = useMentionItems();
  const comments = useTasksQuery(
    async (query) =>
      (await query.call("listComments", { taskId: task.id })).comments,
    ["comments:changed"],
    [task.id],
  );
  const [responding, setResponding] = useState(false);
  const [response, setResponse] = useState("");
  const [busy, setBusy] = useState<"approve" | "request_changes" | null>(null);
  const [resolved, setResolved] = useState(false);
  const latest = latestReviewUpdate(comments.data ?? []);
  const readOnly = task.sourceId === "jira";

  if (resolved) return null;

  const resolve = async (
    decision: "approve" | "request_changes",
    comment = "",
  ) => {
    if (busy) return;
    setBusy(decision);
    try {
      const result = await rpc.call("resolveTaskReview", {
        taskId: task.id,
        decision,
        comment,
      });
      if (!result.ok) {
        onError(result.error.message);
        return;
      }
      setResolved(true);
      setResponding(false);
      setResponse("");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-label="Human review"
      className="mb-5 rounded-lg border border-[color:var(--timeline-accent)]/40 bg-[color:var(--timeline-accent)]/5 p-4 shadow-2xs"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[color:var(--timeline-accent)]/15 text-[color:var(--timeline-accent)]">
          <Icon name="UserRound" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Awaiting human review</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Review the agent update, approve the result, or respond with the
            information and changes needed to continue.
          </p>

          {comments.error ? (
            <p className="mt-3 text-xs text-destructive">{comments.error}</p>
          ) : latest ? (
            <div className="mt-3 rounded-md border border-border bg-card px-3 py-2.5">
              <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Latest update · {latest.authorName}
              </div>
              <TasksEditor
                value={latest.body}
                onChange={() => {}}
                readOnly
                variant="comment"
              />
            </div>
          ) : comments.isLoading ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Loading the latest update…
            </p>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              No agent comment was attached. Review the task changes and
              activity before deciding.
            </p>
          )}

          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {readOnly ? (
              <span className="text-xs text-muted-foreground">
                Review actions are unavailable for read-only Jira tasks.
              </span>
            ) : (
              <>
                {agentBusy ? (
                  <span className="mr-auto self-center text-xs text-muted-foreground">
                    Review actions unlock when the agent finishes its turn.
                  </span>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || agentBusy}
                  onClick={() => setResponding(true)}
                >
                  Respond / request changes
                </Button>
                <Button
                  size="sm"
                  disabled={busy !== null || agentBusy}
                  onClick={() => void resolve("approve")}
                >
                  <Icon name="Check" className="size-3.5" />
                  {busy === "approve" ? "Approving…" : "Approve and complete"}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <Dialog open={responding} onOpenChange={setResponding}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Respond and return to the ready queue</DialogTitle>
            <DialogDescription>
              Your response becomes the rework context for the next agent run.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border bg-card px-3.5 py-3 focus-within:border-input focus-within:ring-1 focus-within:ring-ring">
            <TasksEditor
              value={response}
              onChange={setResponse}
              variant="comment"
              placeholder="Answer the question or describe the requested changes…"
              className="min-h-28"
              mentionItems={mentionItems}
              onSubmit={() => {
                if (response.trim()) {
                  void resolve("request_changes", response.trim());
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setResponding(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={response.trim() === "" || busy !== null}
              onClick={() =>
                void resolve("request_changes", response.trim())
              }
            >
              {busy === "request_changes" ? "Sending…" : "Send and resume"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
