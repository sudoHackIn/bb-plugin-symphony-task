import { useCallback, useEffect, useState } from "react";
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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

function toggled(values: readonly string[], value: string, checked: boolean) {
  if (checked) return values.includes(value) ? [...values] : [...values, value];
  return values.filter((existing) => existing !== value);
}

function LabelPicker({
  options,
  value,
  onChange,
  disabled,
}: {
  options: Dashboard["projects"][number]["labels"];
  value: string[];
  onChange: (labels: string[]) => void;
  disabled: boolean;
}) {
  const optionNames = new Map(
    options.map((option) => [option.value, option.name]),
  );
  const selected = value.map((label) => optionNames.get(label) ?? label);
  const selectable = [
    ...options,
    ...value
      .filter((label) => !optionNames.has(label))
      .map((label) => ({ value: label, name: `${label} (missing)` })),
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || selectable.length === 0}
          className="w-full justify-start font-normal"
        >
          <Icon name="Target" className="size-3.5" />
          <span className="truncate">
            {selected.length > 0
              ? selected.join(", ")
              : options.length === 0
                ? "No labels in tracker"
                : "Select labels"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {selectable.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={value.includes(option.value)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) =>
              onChange(toggled(value, option.value, checked === true))
            }
          >
            {option.name}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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

function TaskPolicyRow({
  task,
  mode,
  labelFilter,
  labelMatch,
  labelNames,
}: {
  task: Dashboard["tasks"][number];
  mode: ExecutionProjectMode;
  labelFilter: string[];
  labelMatch: "any" | "all";
  labelNames: Map<string, string>;
}) {
  const rpc = useRpc<ExecutionRpcContract>();
  const [policy, setPolicy] = useState<TaskExecutionPolicy>(task.policy);
  useEffect(() => setPolicy(task.policy), [task.policy]);
  const inheritedRuns =
    mode === "all_todo" ||
    (mode === "opt_in" &&
      labelFilter.length > 0 &&
      (labelMatch === "all"
        ? labelFilter.every((label) => task.labels.includes(label))
        : labelFilter.some((label) => task.labels.includes(label))));
  const update = async (next: TaskExecutionPolicy) => {
    setPolicy(next);
    try {
      await rpc.call("setTaskExecutionPolicy", {
        tracker: task.tracker,
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
      <div className="min-w-48 flex-1">
        <div className="truncate text-sm">{task.title}</div>
        {task.labels.length > 0 ? (
          <div className="truncate text-xs text-muted-foreground">
            {task.labels.map((label) => labelNames.get(label) ?? label).join(", ")}
          </div>
        ) : null}
      </div>
      {task.latestStatus ? (
        <span className="text-xs text-muted-foreground">
          {formatStatus(task.latestStatus)} · attempt {task.latestAttempt}
        </span>
      ) : null}
      <Select value={policy} onValueChange={(value) => void update(value as TaskExecutionPolicy)}>
        <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">
            Inherit ({inheritedRuns ? "run" : "skip"})
          </SelectItem>
          <SelectItem value="enabled">Always run</SelectItem>
          <SelectItem value="disabled">Never run</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function ProjectPolicyCard({
  project,
  tasks,
  presets,
  refresh,
}: {
  project: Dashboard["projects"][number];
  tasks: Dashboard["tasks"];
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
  const [labelFilter, setLabelFilter] = useState(project.policy.labelFilter);
  const [labelMatch, setLabelMatch] = useState<"any" | "all">(
    project.policy.labelMatch,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMode(project.policy.mode);
    setPresetId(project.policy.presetId ?? "none");
    setMaxWorkers(project.policy.maxWorkers?.toString() ?? "");
    setTokenBudget(project.policy.tokenBudget?.toString() ?? "");
    setLabelFilter(project.policy.labelFilter);
    setLabelMatch(project.policy.labelMatch);
  }, [project.policy]);

  const save = async () => {
    setSaving(true);
    try {
      await rpc.call("setProjectExecutionPolicy", {
        projectId: project.id,
        mode,
        presetId: presetId === "none" ? null : presetId,
        maxWorkers: optionalNumber(maxWorkers),
        tokenBudget: optionalNumber(tokenBudget),
        labelFilter,
        labelMatch,
      });
      await refresh();
      toast.success(`${project.name} execution policy saved`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const labelNames = new Map(
    project.labels.map((label) => [label.value, label.name]),
  );

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0 p-4">
        <div className="min-w-0 space-y-1">
          <CardTitle className="truncate text-sm">{project.name}</CardTitle>
          <CardDescription
            className={cn(!project.supported && "text-warning")}
          >
            {project.source} · {project.supportDetail}
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={saving || !project.supported}
          onClick={() => void save()}
        >
          Save project
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Eligibility</span>
            <Select
              value={mode}
              onValueChange={(value) =>
                setMode(value as ExecutionProjectMode)
              }
              disabled={!project.supported}
            >
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="opt_in">Labels + overrides</SelectItem>
                <SelectItem value="all_todo">All ready tasks</SelectItem>
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
            <span>Project workers</span>
            <Input className="h-8" type="number" min={1} max={32} placeholder="Global ceiling" value={maxWorkers} onChange={(event) => setMaxWorkers(event.target.value)} disabled={!project.supported} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Tokens per run</span>
            <Input className="h-8" type="number" min={1000} placeholder="Global default" value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} disabled={!project.supported} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Label matching</span>
            <Select value={labelMatch} onValueChange={(value) => setLabelMatch(value as "any" | "all")} disabled={!project.supported || mode !== "opt_in"}>
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any selected label</SelectItem>
                <SelectItem value="all">All selected labels</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Automation labels</div>
          <LabelPicker
            options={project.labels}
            value={labelFilter}
            onChange={setLabelFilter}
            disabled={!project.supported || mode !== "opt_in"}
          />
          <p className="text-xs text-muted-foreground">
            In label mode, inherited ready tasks run when they match this project rule. Always/Never below are explicit exceptions.
          </p>
        </div>
        <div className="border-t border-border-hairline pt-3">
          <div className="mb-1 text-xs font-medium">Task overrides</div>
          {tasks.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active tasks in this tracker.</p>
          ) : (
            tasks.map((task) => (
              <TaskPolicyRow
                key={`${task.tracker}:${task.id}`}
                task={task}
                mode={mode}
                labelFilter={labelFilter}
                labelMatch={labelMatch}
                labelNames={labelNames}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
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

  if (!dashboard) {
    return <div className="p-5 text-sm text-muted-foreground">{error ?? "Loading execution controls…"}</div>;
  }
  return (
    <div className="p-4 md:p-5">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        {error ? <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
        <ConfigCard dashboard={dashboard} refresh={refresh} />
        <div className="space-y-2 px-1">
          <h2 className="text-sm font-medium">Project execution policies</h2>
          <p className="text-xs text-muted-foreground">
            Eligibility, labels, preset, workers, and token limits are configured independently for every project.
          </p>
        </div>
        {dashboard.projects.map((project) => (
          <ProjectPolicyCard
            key={project.id}
            project={project}
            tasks={dashboard.tasks.filter(
              (task) => task.projectId === project.id,
            )}
            presets={dashboard.presets}
            refresh={refresh}
          />
        ))}
        <RunsCard dashboard={dashboard} refresh={refresh} />
      </div>
    </div>
  );
}
