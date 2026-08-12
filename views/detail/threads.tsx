import { useState } from "react";
import { useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import type { TaskProvidersRpcContract } from "../../providers/contract.js";
import type {
  Preset,
  Task,
  TaskPullRequest,
  TaskThread,
} from "../../shared/contract.js";
import {
  PR_STATE_META,
  THREAD_STATUS_META,
  formatRelativeTime,
  isActiveThread,
} from "./meta.js";
import {
  PresetDialog,
  savePresetDraft,
} from "../manage/preset-dialog.js";
import { useTasksRpc } from "../../shell/data.js";
import type { WorkflowRpcContract } from "../../workflows/contract.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "../../components/confirm-dialog.js";

/**
 * PR pill on a thread card: a real link to GitHub when the thread's
 * environment has a pull request, a quiet muted marker when the lookup
 * failed, nothing while loading or when no PR exists.
 */
function ThreadPullRequestPill({
  pullRequest,
  unavailable,
}: {
  pullRequest: TaskPullRequest | undefined;
  unavailable: boolean;
}) {
  if (pullRequest) {
    const meta = PR_STATE_META[pullRequest.state];
    return (
      <a
        href={pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${pullRequest.title} (${meta.label})`}
        aria-label={`Pull request #${pullRequest.number}: ${pullRequest.title} (${meta.label})`}
        // Mirrors the app's PullRequestStatusPill: the state icon carries the
        // color, the text stays the normal foreground.
        className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-medium shadow-2xs hover:border-input"
      >
        <Icon name={meta.icon} className={cn("size-3", meta.textClassName)} />
        #{pullRequest.number}
      </a>
    );
  }
  if (unavailable) {
    return (
      <span
        title="Couldn't check this thread's pull request"
        className="shrink-0 text-xs text-muted-foreground"
      >
        PR unavailable
      </span>
    );
  }
  return null;
}

function ThreadCard({
  taskId,
  thread,
  pullRequest,
  pullRequestUnavailable,
  onDetached,
  onError,
}: {
  taskId: string;
  thread: TaskThread;
  pullRequest: TaskPullRequest | undefined;
  pullRequestUnavailable: boolean;
  onDetached: () => void;
  onError: (message: string) => void;
}) {
  const navigate = useBbNavigate();
  const rpc = useTasksRpc();
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const meta = THREAD_STATUS_META[thread.liveStatus];

  const detach = async () => {
    setDetaching(true);
    try {
      await rpc.call("detachTaskThread", {
        taskId,
        threadId: thread.threadId,
      });
      onDetached();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetaching(false);
    }
  };

  return (
    <>
      <div className="mb-2 flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-2xs">
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-xs font-medium",
            meta.textClassName,
          )}
        >
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", meta.dotClassName)}
          />
          {meta.label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{thread.title}</div>
          <div className="text-xs text-muted-foreground">
            {thread.presetName} · attached {formatRelativeTime(thread.attachedAt)}
          </div>
        </div>
        <ThreadPullRequestPill
          pullRequest={pullRequest}
          unavailable={pullRequestUnavailable}
        />
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 text-xs font-medium underline decoration-input underline-offset-2 hover:decoration-current"
          onClick={() => navigate.toThread(thread.threadId)}
        >
          Open thread
          <Icon name="ArrowUpRight" className="size-3" />
        </button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          disabled={detaching}
          className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${thread.title} from task`}
          onClick={() => setConfirmDetach(true)}
        >
          <Icon name="Trash2" className="size-3.5" />
        </Button>
      </div>
      <ConfirmDialog
        open={confirmDetach}
        onOpenChange={setConfirmDetach}
        title="Remove agent thread from this task?"
        description="This only removes the task association. The BB thread itself will not be deleted."
        confirmLabel="Remove from task"
        destructive
        onConfirm={() => void detach()}
      />
    </>
  );
}

const LAST_PRESET_STORAGE_KEY = "bb-tasks:last-dispatch-preset";

function loadLastPresetId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PRESET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLastPresetId(presetId: string): void {
  try {
    window.localStorage.setItem(LAST_PRESET_STORAGE_KEY, presetId);
  } catch {
    // Persistence is best-effort (e.g. sandboxed iframes without storage).
  }
}

export interface DispatchControlProps {
  task: Task;
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  blockedReason?: string;
  align?: "start" | "end";
  className?: string;
}

/**
 * The single dispatch control for a task — rendered in the properties rail
 * on wide layouts and in the inline property row when the rail is hidden.
 * GitHub-merge-style split button around the dispatch RPC: the primary
 * segment opens a per-dispatch prompt editor for the last-used preset
 * (persisted in localStorage; first preset alphabetically as the fallback),
 * and the chevron selects a different preset before opening that editor.
 * The label is just the preset name — the dropdown's "Dispatch with preset"
 * header carries the verb. With zero presets it collapses to an
 * "Add a preset…" button opening the preset dialog in create mode.
 */
export function DispatchControl({
  task,
  presets,
  onError,
  blockedReason,
  align = "end",
  className,
}: DispatchControlProps) {
  const rpc = useRpc<TaskProvidersRpcContract>();
  const workflowRpc = useRpc<WorkflowRpcContract>();
  const tasksRpc = useTasksRpc();
  const [dispatching, setDispatching] = useState(false);
  const [lastPresetId, setLastPresetId] = useState(loadLastPresetId);
  const [pendingPreset, setPendingPreset] = useState<Preset | null>(null);
  const [workflowPresets, setWorkflowPresets] = useState<{
    drafting: string;
    apply: string;
    review: string;
  } | null>(null);
  const [instructions, setInstructions] = useState("");
  // Keyed remount resets the create dialog's draft per open.
  const [createDialogKey, setCreateDialogKey] = useState<number | null>(null);

  const dispatch = async () => {
    if (!pendingPreset) return;
    setDispatching(true);
    try {
      await rpc.call("dispatchTask", {
        taskId: task.id,
        presetId: pendingPreset.id,
        instructions,
      });
      setPendingPreset(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setDispatching(false);
    }
  };
  const startWorkflow = async () => {
    if (!workflowPresets) return;
    setDispatching(true);
    try { await workflowRpc.call("startOpenSpecWorkflow", { taskId: task.id, projectId: task.projectId, presetIds: workflowPresets }); setWorkflowPresets(null); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setDispatching(false); }
  };

  const pickPreset = (preset: Preset) => {
    setLastPresetId(preset.id);
    storeLastPresetId(preset.id);
    setInstructions(preset.instructions);
    setPendingPreset(preset);
  };

  // bg-primary (not the default bg-foreground): custom palettes like Nord
  // define an accent primary the hero CTA should pick up; in the default
  // theme both read as intended.
  const primarySegment =
    "bg-primary text-primary-foreground hover:bg-primary/90";

  if (presets !== undefined && presets.length === 0) {
    return (
      <>
        <Button
          size="sm"
          className={cn("h-7 gap-1.5", primarySegment, className)}
          onClick={() => setCreateDialogKey(Date.now())}
        >
          <Icon name="Plus" className="size-3.5 shrink-0" />
          Add a preset…
        </Button>
        {createDialogKey !== null ? (
          <PresetDialog
            key={createDialogKey}
            open
            onOpenChange={(open) => {
              if (!open) setCreateDialogKey(null);
            }}
            editing={null}
            onSave={(draft) => savePresetDraft(tasksRpc, null, draft)}
          />
        ) : null}
      </>
    );
  }

  const current =
    presets?.find((preset) => preset.id === lastPresetId) ??
    (presets
      ? [...presets].sort((a, b) => a.name.localeCompare(b.name))[0]
      : undefined);

  return (
    <>
      <div className={cn("flex min-w-0", className)} title={blockedReason}>
        <Button
          size="sm"
          disabled={dispatching || !current || blockedReason !== undefined}
          className={cn(
            "h-7 min-w-0 flex-1 gap-1.5 rounded-r-none",
            primarySegment,
          )}
          onClick={() => {
            if (current) pickPreset(current);
          }}
        >
          <span className="truncate">
            {dispatching
              ? "Dispatching…"
              : blockedReason
                ? "Blocked"
              : (current?.name ?? "Dispatch")}
          </span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            asChild
            disabled={dispatching || !current || blockedReason !== undefined}
          >
            <Button
              size="sm"
              aria-label="Choose dispatch preset"
              className={cn(
                "h-7 shrink-0 rounded-l-none border-l border-primary-foreground/25 px-1",
                primarySegment,
              )}
            >
              <Icon name="ChevronDown" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={align}>
            <DropdownMenuLabel>Dispatch with preset</DropdownMenuLabel>
            {(presets ?? []).map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                onSelect={() => pickPreset(preset)}
              >
                <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                <span className="text-xs text-muted-foreground">
                  {preset.modelId}
                </span>
                {preset.id === current?.id ? (
                  <Icon name="Check" className="size-3.5" />
                ) : null}
              </DropdownMenuItem>
            ))}
            {task.sourceId === "beads" ? <><DropdownMenuLabel>Workflow</DropdownMenuLabel><DropdownMenuItem onSelect={() => { if (current) setWorkflowPresets({ drafting: current.id, apply: current.id, review: current.id }); }}>Configure and start OpenSpec</DropdownMenuItem></> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Dialog
        open={pendingPreset !== null}
        onOpenChange={(open) => {
          if (!open && !dispatching) setPendingPreset(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dispatch with {pendingPreset?.name}</DialogTitle>
            <DialogDescription>
              These instructions replace the preset instructions for this dispatch only.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="Optional instructions for this agent"
            className="min-h-40 resize-y font-mono text-xs leading-5"
            spellCheck={false}
            disabled={dispatching}
          />
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={dispatching}
              onClick={() => setPendingPreset(null)}
            >
              Cancel
            </Button>
            <Button disabled={dispatching} onClick={() => void dispatch()}>
              {dispatching ? "Dispatching…" : "Dispatch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={workflowPresets !== null}
        onOpenChange={(open) => { if (!open && !dispatching) setWorkflowPresets(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configure OpenSpec presets</DialogTitle>
            <DialogDescription>
              Each role uses its selected preset's model, reasoning, permissions, and instructions.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            {([
              ["drafting", "Explore, propose, design, and tasks"],
              ["apply", "OpenSpec apply"],
              ["review", "Agent review"],
            ] as const).map(([role, label]) => (
              <label key={role} className="grid gap-1.5 text-sm font-medium">
                {label}
                <Select
                  value={workflowPresets?.[role]}
                  onValueChange={(value) => setWorkflowPresets((current) => current ? { ...current, [role]: value } : current)}
                  disabled={dispatching}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(presets ?? []).map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.name} · {preset.modelId}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={dispatching} onClick={() => setWorkflowPresets(null)}>Cancel</Button>
            <Button disabled={dispatching || !workflowPresets} onClick={() => void startWorkflow()}>
              {dispatching ? "Starting…" : "Start OpenSpec"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export interface ThreadsSectionProps {
  taskId: string;
  threads: TaskThread[];
  /** Undefined while the PR lookup is in flight (cards render without pills). */
  pullRequests: TaskPullRequest[] | undefined;
  unavailableThreadIds: string[];
  onThreadsChanged: () => void;
  onError: (message: string) => void;
}

/** Attached-thread list; the caller skips it entirely when there are none.
 *  Dispatching lives in a single DispatchControl (rail on wide layouts,
 *  inline property row on narrow), not here. */
export function ThreadsSection({
  taskId,
  threads,
  pullRequests,
  unavailableThreadIds,
  onThreadsChanged,
  onError,
}: ThreadsSectionProps) {
  const [threadHistoryOpen, setThreadHistoryOpen] = useState(false);
  const [workflowHistoryOpen, setWorkflowHistoryOpen] = useState(false);
  const activeThreads = threads.filter(isActiveThread);
  // Workflow threads stay attached deliberately: each OpenSpec stage is an
  // auditable artifact of the run. Keep them apart from ordinary historical
  // dispatches so the currently running agent is always the first thing seen.
  const workflowHistory = threads.filter(
    (thread) =>
      !isActiveThread(thread) && thread.presetName.startsWith("OpenSpec ·"),
  );
  const threadHistory = threads.filter(
    (thread) =>
      !isActiveThread(thread) && !thread.presetName.startsWith("OpenSpec ·"),
  );
  const pullRequestByThread = new Map<string, TaskPullRequest>();
  for (const pullRequest of pullRequests ?? []) {
    for (const threadId of pullRequest.threadIds) {
      pullRequestByThread.set(threadId, pullRequest);
    }
  }
  const unavailable = new Set(unavailableThreadIds);
  const renderCard = (thread: TaskThread) => (
    <ThreadCard
      key={thread.id}
      taskId={taskId}
      thread={thread}
      pullRequest={pullRequestByThread.get(thread.threadId)}
      pullRequestUnavailable={unavailable.has(thread.threadId)}
      onDetached={onThreadsChanged}
      onError={onError}
    />
  );

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 pt-1.5 text-xs font-semibold text-muted-foreground">
        Active agents
        {activeThreads.length > 0 ? (
          <span className="font-normal">{activeThreads.length} working now</span>
        ) : null}
      </div>
      {activeThreads.length > 0 ? activeThreads.map(renderCard) : <p className="mb-3 text-xs text-muted-foreground">None active</p>}
      {workflowHistory.length > 0 ? <div className="mt-4"><button type="button" aria-expanded={workflowHistoryOpen} aria-controls={`workflow-history-${taskId}`} onClick={() => setWorkflowHistoryOpen((open) => !open)} className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"><Icon name="ChevronRight" className={cn("size-3.5 transition-transform", workflowHistoryOpen && "rotate-90")} />Workflow history <span className="font-normal">{workflowHistory.length}</span></button>{workflowHistoryOpen ? <div id={`workflow-history-${taskId}`}>{workflowHistory.map(renderCard)}</div> : null}</div> : null}
      {threadHistory.length > 0 ? <div className="mt-4"><button type="button" aria-expanded={threadHistoryOpen} aria-controls={`thread-history-${taskId}`} onClick={() => setThreadHistoryOpen((open) => !open)} className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"><Icon name="ChevronRight" className={cn("size-3.5 transition-transform", threadHistoryOpen && "rotate-90")} />Thread history <span className="font-normal">{threadHistory.length}</span></button>{threadHistoryOpen ? <div id={`thread-history-${taskId}`}>{threadHistory.map(renderCard)}</div> : null}</div> : null}
    </section>
  );
}
