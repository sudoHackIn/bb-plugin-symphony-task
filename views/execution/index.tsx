import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { z } from "zod";
import type {
  ExecutionRpcContract,
  executionRpcContract,
} from "../../execution/contract.js";
import type {
  ExecutionProjectMode,
  TaskExecutionPolicy,
} from "../../execution/types.js";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Dashboard = z.infer<
  (typeof executionRpcContract)["getExecutionDashboard"]["output"]
>;

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function formatStatus(status: string): string {
  return status
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function ConfigCard({
  dashboard,
  refresh,
}: {
  dashboard: Dashboard;
  refresh: () => Promise<void>;
}) {
  const rpc = useRpc<ExecutionRpcContract>();
  const [maxWorkers, setMaxWorkers] = useState(
    String(dashboard.config.maxWorkers),
  );
  const [pollInterval, setPollInterval] = useState(
    String(dashboard.config.pollIntervalSeconds),
  );
  const [tokenBudget, setTokenBudget] = useState(
    dashboard.config.defaultTokenBudget?.toString() ?? "",
  );
  const [maxAttempts, setMaxAttempts] = useState(
    String(dashboard.config.maxAttempts),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMaxWorkers(String(dashboard.config.maxWorkers));
    setPollInterval(String(dashboard.config.pollIntervalSeconds));
    setTokenBudget(dashboard.config.defaultTokenBudget?.toString() ?? "");
    setMaxAttempts(String(dashboard.config.maxAttempts));
  }, [dashboard.config]);

  const save = async (enabled = dashboard.config.enabled) => {
    setSaving(true);
    try {
      await rpc.call("updateExecutionConfig", {
        enabled,
        maxWorkers: Number(maxWorkers),
        pollIntervalSeconds: Number(pollInterval),
        defaultTokenBudget: optionalNumber(tokenBudget),
        maxAttempts: Number(maxAttempts),
      });
      await refresh();
      toast.success(enabled ? "Execution engine running" : "Execution engine paused");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0 p-4">
        <div className="space-y-1">
          <CardTitle className="text-sm">Execution engine</CardTitle>
          <CardDescription>
            Pausing prevents new claims. Existing workers keep running until
            review, failure, their token budget, or a manual stop.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant={dashboard.config.enabled ? "outline" : "default"}
          disabled={saving}
          onClick={() => void save(!dashboard.config.enabled)}
        >
          <Icon
            name={dashboard.config.enabled ? "Pause" : "Play"}
            className="size-3.5"
          />
          {dashboard.config.enabled ? "Pause" : "Start"}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 pt-0 sm:grid-cols-2 lg:grid-cols-4">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Global workers</span>
          <Input
            type="number"
            min={1}
            max={32}
            value={maxWorkers}
            onChange={(event) => setMaxWorkers(event.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Polling, seconds</span>
          <Input
            type="number"
            min={5}
            max={3600}
            value={pollInterval}
            onChange={(event) => setPollInterval(event.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Tokens per run · empty = unlimited</span>
          <Input
            type="number"
            min={1000}
            placeholder="Unlimited"
            value={tokenBudget}
            onChange={(event) => setTokenBudget(event.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Automatic attempts</span>
          <Input
            type="number"
            min={1}
            max={20}
            value={maxAttempts}
            onChange={(event) => setMaxAttempts(event.target.value)}
          />
        </label>
        <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
          <Button size="sm" variant="secondary" disabled={saving} onClick={() => void save()}>
            Save limits
          </Button>
          <span className="text-xs text-muted-foreground">
            {dashboard.activeWorkers} / {dashboard.config.maxWorkers} workers active
          </span>
          <span className="text-xs text-muted-foreground">
            Token enforcement is event-driven and may overshoot slightly.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectPolicyRow({
  project,
  presets,
  refresh,
}: {
  project: Dashboard["projects"][number];
  presets: Dashboard["presets"];
  refresh: () => Promise<void>;
}) {
  const rpc = useRpc<ExecutionRpcContract>();
  const [mode, setMode] = useState<ExecutionProjectMode>(project.policy.mode);
  const [presetId, setPresetId] = useState(project.policy.presetId ?? "none");
  const [maxWorkers, setMaxWorkers] = useState(
    project.policy.maxWorkers?.toString() ?? "",
  );
  const [tokenBudget, setTokenBudget] = useState(
    project.policy.tokenBudget?.toString() ?? "",
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await rpc.call("setProjectExecutionPolicy", {
        projectId: project.id,
        mode,
        presetId: presetId === "none" ? null : presetId,
        maxWorkers: optionalNumber(maxWorkers),
        tokenBudget: optionalNumber(tokenBudget),
      });
      await refresh();
      toast.success(`${project.name} execution policy saved`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-3 border-t border-border-hairline py-3 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(10rem,1fr)_9rem_11rem_8rem_9rem_auto] lg:items-end">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{project.name}</div>
        <div className={cn("text-xs", project.supported ? "text-muted-foreground" : "text-warning") }>
          {project.source} · {project.supportDetail}
        </div>
      </div>
      <label className="space-y-1 text-xs text-muted-foreground">
        <span>Automation</span>
        <Select value={mode} onValueChange={(value) => setMode(value as ExecutionProjectMode)} disabled={!project.supported}>
          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="off">Off</SelectItem>
            <SelectItem value="opt_in">Opt-in tasks</SelectItem>
            <SelectItem value="all_todo">All Todo</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">
        <span>Agent preset</span>
        <Select value={presetId} onValueChange={setPresetId} disabled={!project.supported}>
          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Not selected</SelectItem>
            {presets.map((preset) => <SelectItem key={preset.id} value={preset.id}>{preset.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">
        <span>Workers</span>
        <Input className="h-8" type="number" min={1} max={32} placeholder="Global" value={maxWorkers} onChange={(event) => setMaxWorkers(event.target.value)} disabled={!project.supported} />
      </label>
      <label className="space-y-1 text-xs text-muted-foreground">
        <span>Token budget</span>
        <Input className="h-8" type="number" min={1000} placeholder="Global" value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} disabled={!project.supported} />
      </label>
      <Button size="sm" variant="secondary" disabled={saving || !project.supported} onClick={() => void save()}>
        Save
      </Button>
    </div>
  );
}

function TaskPolicyRow({
  task,
  projectMode,
}: {
  task: Dashboard["tasks"][number];
  projectMode: ExecutionProjectMode;
}) {
  const rpc = useRpc<ExecutionRpcContract>();
  const [policy, setPolicy] = useState<TaskExecutionPolicy>(task.policy);
  const update = async (next: TaskExecutionPolicy) => {
    setPolicy(next);
    try {
      await rpc.call("setTaskExecutionPolicy", {
        tracker: "local",
        projectId: task.projectId,
        workItemId: task.id,
        policy: next,
      });
    } catch (error) {
      setPolicy(task.policy);
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border-hairline py-2 first:border-t-0">
      <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{task.key}</span>
      <span className="min-w-48 flex-1 truncate text-sm">{task.title}</span>
      {task.latestStatus ? (
        <span className="text-xs text-muted-foreground">
          {formatStatus(task.latestStatus)} · attempt {task.latestAttempt}
        </span>
      ) : null}
      <Select value={policy} onValueChange={(value) => void update(value as TaskExecutionPolicy)}>
        <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">
            Inherit ({projectMode === "all_todo" ? "run" : "skip"})
          </SelectItem>
          <SelectItem value="enabled">Always run</SelectItem>
          <SelectItem value="disabled">Never run</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function RunsCard({
  dashboard,
  refresh,
}: {
  dashboard: Dashboard;
  refresh: () => Promise<void>;
}) {
  const rpc = useRpc<ExecutionRpcContract>();
  const navigate = useBbNavigate();
  const act = async (method: "stopExecutionRun" | "retryExecutionRun", runId: string) => {
    try {
      await rpc.call(method, { runId });
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Card>
      <CardHeader className="p-4">
        <CardTitle className="text-sm">Recent executions</CardTitle>
        <CardDescription>Claims, threads, attempts, and observed token usage.</CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {dashboard.runs.length === 0 ? <p className="text-sm text-muted-foreground">No execution runs yet.</p> : dashboard.runs.map((run) => {
          const active = run.status === "claimed" || run.status === "starting" || run.status === "running";
          const retryable = run.status === "failed" || run.status === "budget_exhausted" || run.status === "canceled";
          return (
            <div key={run.id} className="flex flex-wrap items-center gap-3 border-t border-border-hairline py-2 first:border-t-0">
              <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{run.taskKey}</span>
              <div className="min-w-48 flex-1">
                <div className="truncate text-sm">{run.taskTitle}</div>
                {run.error ? <div className="truncate text-xs text-destructive">{run.error}</div> : null}
              </div>
              <span className="text-xs text-muted-foreground">{formatStatus(run.status)} · attempt {run.attempt}</span>
              <span className="w-32 text-right text-xs tabular-nums text-muted-foreground">
                {run.tokensUsed.toLocaleString()}{run.tokenBudget === null ? " tokens" : ` / ${run.tokenBudget.toLocaleString()}`}
              </span>
              {run.threadId ? <Button size="sm" variant="ghost" onClick={() => navigate.toThread(run.threadId!)}>Open</Button> : null}
              {active ? <Button size="sm" variant="outline" onClick={() => void act("stopExecutionRun", run.id)}>Stop</Button> : null}
              {retryable ? <Button size="sm" variant="secondary" onClick={() => void act("retryExecutionRun", run.id)}>Retry</Button> : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function ExecutionView() {
  const rpc = useRpc<ExecutionRpcContract>();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await rpc.call("getExecutionDashboard");
      setDashboard(next);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [rpc]);
  useEffect(() => { void refresh(); }, [refresh]);
  useRealtime("execution:changed", () => void refresh());

  const projectMode = useMemo(
    () => new Map((dashboard?.projects ?? []).map((project) => [project.id, project.policy.mode])),
    [dashboard],
  );
  if (!dashboard) {
    return <div className="p-5 text-sm text-muted-foreground">{error ?? "Loading execution controls…"}</div>;
  }
  return (
    <div className="p-4 md:p-5">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        {error ? <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
        <ConfigCard dashboard={dashboard} refresh={refresh} />
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">Project workers</CardTitle>
            <CardDescription>
              Projects default to Off. Opt-in runs only explicitly enabled tasks; All Todo runs every inherited Todo task.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {dashboard.projects.map((project) => <ProjectPolicyRow key={project.id} project={project} presets={dashboard.presets} refresh={refresh} />)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="p-4">
            <CardTitle className="text-sm">Task eligibility</CardTitle>
            <CardDescription>Per-task policy wins over the project automation mode.</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {dashboard.tasks.length === 0 ? <p className="text-sm text-muted-foreground">No local Todo, active, or review tasks.</p> : dashboard.tasks.map((task) => <TaskPolicyRow key={task.id} task={task} projectMode={projectMode.get(task.projectId) ?? "off"} />)}
          </CardContent>
        </Card>
        <RunsCard dashboard={dashboard} refresh={refresh} />
      </div>
    </div>
  );
}
