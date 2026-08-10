import { randomUUID } from "node:crypto";
import type { PluginDatabase } from "../api/index.js";
import type {
  EligibleWorkItem,
  ExecutionConfig,
  ExecutionLabelMatch,
  ExecutionProjectMode,
  ExecutionRun,
  ExecutionRunStatus,
  ProjectExecutionPolicy,
  TaskExecutionPolicy,
  TaskExecutionPolicyRecord,
} from "./types.js";
import { matchesProjectEligibility } from "./eligibility.js";

const ACTIVE_STATUSES: readonly ExecutionRunStatus[] = [
  "claimed",
  "starting",
  "running",
];

interface ConfigRow {
  enabled: number;
  max_workers: number;
  poll_interval_seconds: number;
  default_token_budget: number | null;
  max_attempts: number;
  updated_at: string;
}

interface ProjectPolicyRow {
  project_id: string;
  mode: ExecutionProjectMode;
  preset_id: string | null;
  max_workers: number | null;
  token_budget: number | null;
  label_filter: string;
  label_match: ExecutionLabelMatch;
  updated_at: string;
}

interface TaskPolicyRow {
  tracker: TaskExecutionPolicyRecord["tracker"];
  project_id: string;
  work_item_id: string;
  policy: TaskExecutionPolicy;
  updated_at: string;
}

interface RunRow {
  id: string;
  tracker: ExecutionRun["tracker"];
  project_id: string;
  work_item_id: string;
  task_key: string;
  task_title: string;
  external_version: string;
  thread_id: string | null;
  claim_id: string;
  claim_expires_at: string | null;
  status: ExecutionRunStatus;
  attempt: number;
  preset_id: string | null;
  token_budget: number | null;
  tokens_used: number;
  last_event_seq: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

interface EligibleRow {
  id: string;
  project_id: string;
  task_key: string;
  title: string;
  task_status: string;
  updated_at: string;
  policy: TaskExecutionPolicy | null;
  latest_status: ExecutionRunStatus | null;
  latest_attempt: number | null;
  label_values: string | null;
}

function parseLabelFilter(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((label): label is string => typeof label === "string")
      : [];
  } catch {
    return [];
  }
}

function rowLabels(row: EligibleRow): string[] {
  return row.label_values?.split(",").filter(Boolean) ?? [];
}

function configFromRow(row: ConfigRow): ExecutionConfig {
  return {
    enabled: row.enabled === 1,
    maxWorkers: row.max_workers,
    pollIntervalSeconds: row.poll_interval_seconds,
    defaultTokenBudget: row.default_token_budget,
    maxAttempts: row.max_attempts,
    updatedAt: row.updated_at,
  };
}

function projectPolicyFromRow(row: ProjectPolicyRow): ProjectExecutionPolicy {
  return {
    projectId: row.project_id,
    mode: row.mode,
    presetId: row.preset_id,
    maxWorkers: row.max_workers,
    tokenBudget: row.token_budget,
    labelFilter: parseLabelFilter(row.label_filter),
    labelMatch: row.label_match,
    updatedAt: row.updated_at,
  };
}

function taskPolicyFromRow(row: TaskPolicyRow): TaskExecutionPolicyRecord {
  return {
    tracker: row.tracker,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    policy: row.policy,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row: RunRow): ExecutionRun {
  return {
    id: row.id,
    tracker: row.tracker,
    projectId: row.project_id,
    workItemId: row.work_item_id,
    taskKey: row.task_key,
    taskTitle: row.task_title,
    externalVersion: row.external_version,
    threadId: row.thread_id,
    claimId: row.claim_id,
    claimExpiresAt: row.claim_expires_at,
    status: row.status,
    attempt: row.attempt,
    presetId: row.preset_id,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    lastEventSeq: row.last_event_seq,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function leaseExpiry(seconds = 120): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

export interface ExecutionStore {
  getConfig(): ExecutionConfig;
  updateConfig(input: Omit<ExecutionConfig, "updatedAt">): ExecutionConfig;
  listProjectPolicies(): ProjectExecutionPolicy[];
  getProjectPolicy(projectId: string): ProjectExecutionPolicy;
  setProjectPolicy(input: Omit<ProjectExecutionPolicy, "updatedAt">): ProjectExecutionPolicy;
  listTaskPolicies(projectId?: string): TaskExecutionPolicyRecord[];
  getTaskPolicy(
    tracker: ExecutionRun["tracker"],
    projectId: string,
    workItemId: string,
  ): TaskExecutionPolicyRecord | null;
  setTaskPolicy(input: Omit<TaskExecutionPolicyRecord, "updatedAt">): TaskExecutionPolicyRecord;
  listLocalAutomationTasks(projectId?: string): EligibleWorkItem[];
  listEligibleLocal(input: {
    policy: ProjectExecutionPolicy;
    maxAttempts: number;
    limit: number;
  }): EligibleWorkItem[];
  claimLocal(input: {
    item: EligibleWorkItem;
    presetId: string;
    tokenBudget: number | null;
  }): ExecutionRun | null;
  claimExternal(input: {
    tracker: Exclude<ExecutionRun["tracker"], "local">;
    item: EligibleWorkItem;
    claimId: string;
    claimExpiresAt: string;
    presetId: string;
    tokenBudget: number | null;
  }): ExecutionRun | null;
  attachThread(runId: string, threadId: string): ExecutionRun;
  getRun(runId: string): ExecutionRun | null;
  getLatestRun(
    tracker: ExecutionRun["tracker"],
    projectId: string,
    workItemId: string,
  ): ExecutionRun | null;
  getRunByThread(threadId: string): ExecutionRun | null;
  listRuns(limit?: number): ExecutionRun[];
  listActiveRuns(): ExecutionRun[];
  countActiveRuns(projectId?: string): number;
  renew(runId: string): void;
  updateRunStatus(runId: string, status: ExecutionRunStatus, error?: string | null): void;
  updateUsage(runId: string, tokensUsed: number, lastEventSeq: number): void;
  requestRetry(runId: string): void;
}

export function createExecutionStore(database: PluginDatabase): ExecutionStore {
  const getConfig = (): ExecutionConfig => {
    const row = database
      .prepare<[], ConfigRow>("SELECT * FROM execution_config WHERE id = 1")
      .get();
    if (!row) throw new Error("Execution configuration is missing");
    return configFromRow(row);
  };

  const getRun = (runId: string): ExecutionRun | null => {
    const row = database
      .prepare<[string], RunRow>("SELECT * FROM execution_runs WHERE id = ?")
      .get(runId);
    return row ? runFromRow(row) : null;
  };

  const latestRun = (
    tracker: ExecutionRun["tracker"],
    projectId: string,
    workItemId: string,
  ): ExecutionRun | null => {
    const row = database
      .prepare<[ExecutionRun["tracker"], string, string], RunRow>(
        `
          SELECT * FROM execution_runs
          WHERE tracker = ? AND project_id = ? AND work_item_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `,
      )
      .get(tracker, projectId, workItemId);
    return row ? runFromRow(row) : null;
  };

  const listLocalRows = (projectId?: string): EligibleRow[] =>
    database
      .prepare<[string, string], EligibleRow>(
        `
          SELECT
            t.id,
            t.project_id,
            p.prefix || '-' || t.number AS task_key,
            t.title,
            t.status AS task_status,
            t.updated_at,
            (
              SELECT GROUP_CONCAT(tl.label_id, ',')
              FROM task_labels tl
              WHERE tl.task_id = t.id
            ) AS label_values,
            tep.policy,
            (
              SELECT er.status FROM execution_runs er
              WHERE er.tracker = 'local'
                AND er.project_id = t.project_id
                AND er.work_item_id = t.id
              ORDER BY er.created_at DESC, er.id DESC
              LIMIT 1
            ) AS latest_status,
            (
              SELECT er.attempt FROM execution_runs er
              WHERE er.tracker = 'local'
                AND er.project_id = t.project_id
                AND er.work_item_id = t.id
              ORDER BY er.created_at DESC, er.id DESC
              LIMIT 1
            ) AS latest_attempt
          FROM tasks t
          JOIN projects p ON p.id = t.project_id
          LEFT JOIN task_execution_policies tep
            ON tep.tracker = 'local'
            AND tep.project_id = t.project_id
            AND tep.work_item_id = t.id
          WHERE t.parent_task_id IS NULL
            AND t.status IN ('todo', 'in_progress', 'in_review')
            AND (? = '' OR t.project_id = ?)
          ORDER BY
            CASE t.status WHEN 'in_progress' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END,
            CASE t.priority
              WHEN 'urgent' THEN 0
              WHEN 'high' THEN 1
              WHEN 'medium' THEN 2
              WHEN 'low' THEN 3
              ELSE 4
            END,
            t.updated_at DESC
          LIMIT 500
        `,
      )
      .all(projectId ?? "", projectId ?? "");

  return {
    getConfig,
    updateConfig(input) {
      const updatedAt = nowIso();
      database
        .prepare<[number, number, number, number | null, number, string]>(
          `
            UPDATE execution_config SET
              enabled = ?,
              max_workers = ?,
              poll_interval_seconds = ?,
              default_token_budget = ?,
              max_attempts = ?,
              updated_at = ?
            WHERE id = 1
          `,
        )
        .run(
          input.enabled ? 1 : 0,
          input.maxWorkers,
          input.pollIntervalSeconds,
          input.defaultTokenBudget,
          input.maxAttempts,
          updatedAt,
        );
      return getConfig();
    },
    listProjectPolicies() {
      return database
        .prepare<[], ProjectPolicyRow>(
          "SELECT * FROM project_execution_policies ORDER BY project_id",
        )
        .all()
        .map(projectPolicyFromRow);
    },
    getProjectPolicy(projectId) {
      const row = database
        .prepare<[string], ProjectPolicyRow>(
          "SELECT * FROM project_execution_policies WHERE project_id = ?",
        )
        .get(projectId);
      return row
        ? projectPolicyFromRow(row)
        : {
            projectId,
            mode: "off",
            presetId: null,
            maxWorkers: null,
            tokenBudget: null,
            labelFilter: [],
            labelMatch: "any",
            updatedAt: new Date(0).toISOString(),
          };
    },
    setProjectPolicy(input) {
      const updatedAt = nowIso();
      database
        .prepare<
          [
            string,
            ExecutionProjectMode,
            string | null,
            number | null,
            number | null,
            string,
            ExecutionLabelMatch,
            string,
          ]
        >(
          `
            INSERT INTO project_execution_policies (
              project_id, mode, preset_id, max_workers, token_budget,
              label_filter, label_match, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
              mode = excluded.mode,
              preset_id = excluded.preset_id,
              max_workers = excluded.max_workers,
              token_budget = excluded.token_budget,
              label_filter = excluded.label_filter,
              label_match = excluded.label_match,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          input.projectId,
          input.mode,
          input.presetId,
          input.maxWorkers,
          input.tokenBudget,
          JSON.stringify(Array.from(new Set(input.labelFilter))),
          input.labelMatch,
          updatedAt,
        );
      return this.getProjectPolicy(input.projectId);
    },
    listTaskPolicies(projectId) {
      const rows = projectId
        ? database
            .prepare<[string], TaskPolicyRow>(
              "SELECT * FROM task_execution_policies WHERE project_id = ? ORDER BY work_item_id",
            )
            .all(projectId)
        : database
            .prepare<[], TaskPolicyRow>(
              "SELECT * FROM task_execution_policies ORDER BY project_id, work_item_id",
            )
            .all();
      return rows.map(taskPolicyFromRow);
    },
    getTaskPolicy(tracker, projectId, workItemId) {
      const row = database
        .prepare<
          [ExecutionRun["tracker"], string, string],
          TaskPolicyRow
        >(
          `
            SELECT * FROM task_execution_policies
            WHERE tracker = ? AND project_id = ? AND work_item_id = ?
          `,
        )
        .get(tracker, projectId, workItemId);
      return row ? taskPolicyFromRow(row) : null;
    },
    setTaskPolicy(input) {
      const updatedAt = nowIso();
      database
        .prepare<
          [ExecutionRun["tracker"], string, string, TaskExecutionPolicy, string]
        >(
          `
            INSERT INTO task_execution_policies (
              tracker, project_id, work_item_id, policy, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(tracker, project_id, work_item_id) DO UPDATE SET
              policy = excluded.policy,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          input.tracker,
          input.projectId,
          input.workItemId,
          input.policy,
          updatedAt,
        );
      return {
        ...input,
        updatedAt,
      };
    },
    listLocalAutomationTasks(projectId) {
      return listLocalRows(projectId).map((row) => ({
        id: row.id,
        projectId: row.project_id,
        key: row.task_key,
        title: row.title,
        version: row.updated_at,
        labels: rowLabels(row),
        policy: row.policy ?? "inherit",
        latestStatus: row.latest_status,
        latestAttempt: row.latest_attempt,
      }));
    },
    listEligibleLocal(input) {
      if (input.policy.mode === "off") return [];
      return listLocalRows(input.policy.projectId)
        .filter((row) => {
          if (row.task_status !== "todo") return false;
          const policy = row.policy ?? "inherit";
          if (!matchesProjectEligibility(rowLabels(row), policy, input.policy))
            return false;
          if (row.latest_status === "budget_exhausted") return false;
          if (
            row.latest_status === "failed" &&
            (row.latest_attempt ?? 0) >= input.maxAttempts
          ) {
            return false;
          }
          return true;
        })
        .slice(0, input.limit)
        .map((row) => ({
          id: row.id,
          projectId: row.project_id,
          key: row.task_key,
          title: row.title,
          version: row.updated_at,
          labels: rowLabels(row),
          policy: row.policy ?? "inherit",
          latestStatus: row.latest_status,
          latestAttempt: row.latest_attempt,
        }));
    },
    claimLocal(input) {
      return database.transaction(() => {
        const task = database
          .prepare<[string, string], { status: string; updated_at: string }>(
            "SELECT status, updated_at FROM tasks WHERE id = ? AND project_id = ?",
          )
          .get(input.item.id, input.item.projectId);
        if (!task || task.status !== "todo" || task.updated_at !== input.item.version) {
          return null;
        }
        const active = database
          .prepare<[string, string], { found: number }>(
            `
              SELECT 1 AS found FROM execution_runs
              WHERE tracker = 'local' AND project_id = ? AND work_item_id = ?
                AND status IN ('claimed', 'starting', 'running')
              LIMIT 1
            `,
          )
          .get(input.item.projectId, input.item.id);
        if (active) return null;

        const previous = latestRun("local", input.item.projectId, input.item.id);
        const attempt = previous?.status === "failed" ? previous.attempt + 1 : 1;
        const createdAt = nowIso();
        const id = randomUUID();
        database
          .prepare<
            [
              string,
              string,
              string,
              string,
              string,
              string,
              string,
              string,
              number,
              string,
              number | null,
              string,
              string,
            ]
          >(
            `
              INSERT INTO execution_runs (
                id, tracker, project_id, work_item_id, task_key, task_title,
                external_version, claim_id, claim_expires_at, status, attempt,
                preset_id, token_budget, created_at, updated_at
              ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?)
            `,
          )
          .run(
            id,
            input.item.projectId,
            input.item.id,
            input.item.key,
            input.item.title,
            input.item.version,
            randomUUID(),
            leaseExpiry(),
            attempt,
            input.presetId,
            input.tokenBudget,
            createdAt,
            createdAt,
          );
        return getRun(id);
      })();
    },
    claimExternal(input) {
      return database.transaction(() => {
        const active = database
          .prepare<
            [ExecutionRun["tracker"], string, string],
            { found: number }
          >(
            `
              SELECT 1 AS found FROM execution_runs
              WHERE tracker = ? AND project_id = ? AND work_item_id = ?
                AND status IN ('claimed', 'starting', 'running')
              LIMIT 1
            `,
          )
          .get(input.tracker, input.item.projectId, input.item.id);
        if (active) return null;

        const previous = latestRun(
          input.tracker,
          input.item.projectId,
          input.item.id,
        );
        const attempt = previous ? previous.attempt + 1 : 1;
        const createdAt = nowIso();
        const id = randomUUID();
        database
          .prepare<
            [
              string,
              ExecutionRun["tracker"],
              string,
              string,
              string,
              string,
              string,
              string,
              string,
              number,
              string,
              number | null,
              string,
              string,
            ]
          >(
            `
              INSERT INTO execution_runs (
                id, tracker, project_id, work_item_id, task_key, task_title,
                external_version, claim_id, claim_expires_at, status, attempt,
                preset_id, token_budget, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?)
            `,
          )
          .run(
            id,
            input.tracker,
            input.item.projectId,
            input.item.id,
            input.item.key,
            input.item.title,
            input.item.version,
            input.claimId,
            input.claimExpiresAt,
            attempt,
            input.presetId,
            input.tokenBudget,
            createdAt,
            createdAt,
          );
        return getRun(id);
      })();
    },
    attachThread(runId, threadId) {
      database
        .prepare<[string, string, string, string]>(
          `
            UPDATE execution_runs SET
              thread_id = ?, status = 'starting', claim_expires_at = ?, updated_at = ?
            WHERE id = ? AND status = 'claimed'
          `,
        )
        .run(threadId, leaseExpiry(), nowIso(), runId);
      const run = getRun(runId);
      if (!run) throw new Error(`Execution run not found: ${runId}`);
      return run;
    },
    getRun,
    getLatestRun: latestRun,
    getRunByThread(threadId) {
      const row = database
        .prepare<[string], RunRow>(
          "SELECT * FROM execution_runs WHERE thread_id = ? LIMIT 1",
        )
        .get(threadId);
      return row ? runFromRow(row) : null;
    },
    listRuns(limit = 100) {
      return database
        .prepare<[number], RunRow>(
          "SELECT * FROM execution_runs ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .all(limit)
        .map(runFromRow);
    },
    listActiveRuns() {
      return database
        .prepare<[], RunRow>(
          "SELECT * FROM execution_runs WHERE status IN ('claimed', 'starting', 'running') ORDER BY created_at",
        )
        .all()
        .map(runFromRow);
    },
    countActiveRuns(projectId) {
      const row = projectId
        ? database
            .prepare<[string], { count: number }>(
              "SELECT COUNT(*) AS count FROM execution_runs WHERE project_id = ? AND status IN ('claimed', 'starting', 'running')",
            )
            .get(projectId)
        : database
            .prepare<[], { count: number }>(
              "SELECT COUNT(*) AS count FROM execution_runs WHERE status IN ('claimed', 'starting', 'running')",
            )
            .get();
      return row?.count ?? 0;
    },
    renew(runId) {
      database
        .prepare<[string, string, string]>(
          `
            UPDATE execution_runs SET claim_expires_at = ?, updated_at = ?
            WHERE id = ? AND status IN ('claimed', 'starting', 'running')
          `,
        )
        .run(leaseExpiry(), nowIso(), runId);
    },
    updateRunStatus(runId, status, error = null) {
      const terminal = !ACTIVE_STATUSES.includes(status);
      database
        .prepare<[ExecutionRunStatus, string | null, string | null, string | null, string, string]>(
          `
            UPDATE execution_runs SET
              status = ?,
              error = ?,
              claim_expires_at = ?,
              finished_at = ?,
              updated_at = ?
            WHERE id = ?
          `,
        )
        .run(
          status,
          error,
          terminal ? null : leaseExpiry(),
          terminal ? nowIso() : null,
          nowIso(),
          runId,
        );
    },
    updateUsage(runId, tokensUsed, lastEventSeq) {
      database
        .prepare<[number, number, string, string]>(
          `
            UPDATE execution_runs
            SET tokens_used = MAX(tokens_used, ?), last_event_seq = MAX(last_event_seq, ?), updated_at = ?
            WHERE id = ?
          `,
        )
        .run(tokensUsed, lastEventSeq, nowIso(), runId);
    },
    requestRetry(runId) {
      database
        .prepare<[string, string, string]>(
          `
            UPDATE execution_runs
            SET status = 'released', error = NULL, finished_at = ?, updated_at = ?
            WHERE id = ? AND status IN ('failed', 'budget_exhausted', 'canceled')
          `,
        )
        .run(nowIso(), nowIso(), runId);
    },
  };
}
