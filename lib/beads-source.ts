import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CreateTaskInput,
  TaskPriority,
  TaskSource,
  TaskStatus,
  TaskLinkType,
  UnifiedComment,
  UnifiedTaskLink,
  UnifiedTask,
  UpdateTaskInput,
} from "./task-source.js";

const execFileAsync = promisify(execFile);

export const BEADS_REVIEW_LABEL = "symphony:review";
export const BEADS_CLAIM_METADATA = {
  candidate: "symphony.candidate",
  claimId: "symphony.claim_id",
  expiresAt: "symphony.expires_at",
  threadId: "symphony.thread_id",
} as const;

export async function isBeadsCliAvailable(executable: string): Promise<boolean> {
  try {
    await execFileAsync(executable, ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function isBeadsWorkspace(
  workspacePath: string,
  executable: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(executable, ["where", "--json"], {
      cwd: workspacePath,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(stdout) as { error?: unknown };
    return !result.error;
  } catch {
    return false;
  }
}

interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  labels?: string[];
  assignee?: string;
  external_ref?: string;
  parent?: string;
  blocked_by?: string[];
  metadata?: Record<string, unknown>;
  updated_at?: string;
}

interface BeadsComment {
  id: string;
  author?: string;
  text?: string;
  created_at?: string;
}

interface BeadsLinkedIssue extends BeadsIssue {
  dependency_type?: string;
}

const PRIORITY_FROM_BEADS: Record<number, TaskPriority> = {
  0: "urgent",
  1: "high",
  2: "medium",
  3: "low",
  4: "none",
};

const PRIORITY_TO_BEADS: Record<TaskPriority, string> = {
  urgent: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
  none: "P4",
};

function normalizeStatus(
  status: string | undefined,
  labels: readonly string[] = [],
): TaskStatus {
  if (status === "open" && labels.includes(BEADS_REVIEW_LABEL)) {
    return "in_review";
  }
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "blocked":
    case "deferred":
      return "blocked";
    case "closed":
      return "done";
    default:
      return "backlog";
  }
}

function beadsStatus(status: TaskStatus): string {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "in_review":
      return "open";
    case "blocked":
      return "blocked";
    case "done":
      return "closed";
    default:
      return "open";
  }
}

function normalizeIssue(
  issue: BeadsIssue,
  blockedByIds: string[] = issue.blocked_by ?? [],
): UnifiedTask {
  return {
    id: issue.id,
    sourceId: "beads",
    key: issue.id,
    title: issue.title,
    description: issue.description ?? "",
    status: normalizeStatus(issue.status, issue.labels),
    nativeStatus: issue.status ?? "open",
    priority: PRIORITY_FROM_BEADS[issue.priority ?? 4] ?? "none",
    type: issue.issue_type ?? "task",
    labels: issue.labels ?? [],
    assignee: issue.assignee ?? null,
    externalRef: issue.external_ref ?? null,
    parentId: issue.parent ?? null,
    blockedByIds,
    updatedAt: issue.updated_at ?? new Date(0).toISOString(),
    readOnly: false,
  };
}

function parseIssues(stdout: string): BeadsIssue[] {
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value)) throw new Error("Beads returned an invalid issue list");
  return value as BeadsIssue[];
}

function parseIssue(stdout: string): BeadsIssue {
  const value: unknown = JSON.parse(stdout);
  const issue = Array.isArray(value) ? value[0] : value;
  if (!issue || typeof issue !== "object")
    throw new Error("Beads returned an invalid issue");
  return issue as BeadsIssue;
}

function metadataString(issue: BeadsIssue, key: string): string | null {
  const value = issue.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface BeadsClaimInput {
  issueId: string;
  owner: string;
  claimId: string;
  expiresAt: string;
}

export interface BeadsClaimMutation extends BeadsClaimInput {
  threadId?: string | null;
}

function normalizeComment(comment: BeadsComment): UnifiedComment {
  return {
    id: comment.id,
    author: comment.author?.trim() || "Unknown",
    body: comment.text ?? "",
    createdAt: comment.created_at ?? new Date(0).toISOString(),
  };
}

function parseComments(stdout: string): UnifiedComment[] {
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value))
    throw new Error("Beads returned an invalid comment list");
  return (value as BeadsComment[]).map(normalizeComment);
}

function parseComment(stdout: string): UnifiedComment {
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== "object" || !("id" in value))
    throw new Error("Beads returned an invalid comment");
  return normalizeComment(value as BeadsComment);
}

function parseLinks(
  stdout: string,
  direction: UnifiedTaskLink["direction"],
): UnifiedTaskLink[] {
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value))
    throw new Error("Beads returned an invalid dependency list");
  return (value as BeadsLinkedIssue[])
    .filter((issue) => issue.dependency_type !== "parent-child")
    .map((issue) => ({
      direction,
      type: issue.dependency_type ?? "blocks",
      task: normalizeIssue(issue),
    }));
}

export class BeadsTaskSource implements TaskSource {
  readonly id = "beads";
  private revisionMode: "unknown" | "sql" | "vc" = "unknown";
  private vcRevisionReliable: boolean | null = null;

  constructor(
    private readonly workspacePath: string,
    private readonly executable: string,
  ) {}

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.executable, args, {
        cwd: this.workspacePath,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30_000,
      });
      return stdout;
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new Error(detail.stderr?.trim() || detail.message);
    }
  }

  private async clearCandidate(issueId: string, claimId: string): Promise<void> {
    try {
      const current = parseIssue(await this.run(["show", issueId, "--json"]));
      if (
        metadataString(current, BEADS_CLAIM_METADATA.candidate) !== claimId
      ) {
        return;
      }
      await this.run([
        "update",
        issueId,
        "--unset-metadata",
        BEADS_CLAIM_METADATA.candidate,
        "--json",
      ]);
    } catch {
      // The next eligibility pass can safely overwrite a stale candidate.
    }
  }

  async revision(): Promise<string> {
    if (this.revisionMode !== "vc") {
      try {
        const stdout = await this.run([
          "sql",
          "SELECT dolt_hashof_db() AS revision",
          "--csv",
          "--readonly",
        ]);
        const lines = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const revision = lines.at(-1);
        if (!revision || revision.toLocaleLowerCase() === "revision") {
          throw new Error("Beads returned an invalid database revision");
        }
        this.revisionMode = "sql";
        return `sql:${revision}`;
      } catch {
        // bd 1.0 embedded mode does not expose `bd sql`. Its normal write
        // path auto-commits Dolt changes, so vc status is the supported
        // revision source there.
        this.revisionMode = "vc";
      }
    }

    if (this.vcRevisionReliable === null) {
      try {
        const configStdout = await this.run([
          "config",
          "get",
          "dolt.auto-commit",
          "--json",
          "--readonly",
        ]);
        const config: unknown = JSON.parse(configStdout);
        this.vcRevisionReliable = Boolean(
          config &&
            typeof config === "object" &&
            "value" in config &&
            config.value === "on",
        );
      } catch {
        this.vcRevisionReliable = false;
      }
    }
    if (!this.vcRevisionReliable) {
      throw new Error(
        "Beads vc revision requires dolt.auto-commit=on",
      );
    }

    const stdout = await this.run(["vc", "status", "--json", "--readonly"]);
    const value: unknown = JSON.parse(stdout);
    if (
      !value ||
      typeof value !== "object" ||
      !("commit" in value) ||
      typeof value.commit !== "string" ||
      value.commit.length === 0
    ) {
      throw new Error("Beads returned an invalid version-control revision");
    }
    // Preserve the complete stable JSON payload so future bd versions can
    // expose dirty working-set fields without another plugin change.
    return `vc:${JSON.stringify(value)}`;
  }

  async list(): Promise<UnifiedTask[]> {
    const [listStdout, blockedStdout] = await Promise.all([
      this.run(["list", "--all", "--flat", "--limit", "0", "--json"]),
      this.run(["blocked", "--json"]),
    ]);
    const blockedBy = new Map(
      parseIssues(blockedStdout).map((issue) => [
        issue.id,
        issue.blocked_by ?? [],
      ]),
    );
    return parseIssues(listStdout).map((issue) =>
      normalizeIssue(issue, blockedBy.get(issue.id) ?? []),
    );
  }

  async get(id: string): Promise<UnifiedTask> {
    return normalizeIssue(parseIssue(await this.run(["show", id, "--json"])));
  }

  async listReady(): Promise<UnifiedTask[]> {
    return parseIssues(
      await this.run([
        "ready",
        "--limit",
        "0",
        "--exclude-label",
        BEADS_REVIEW_LABEL,
        "--json",
      ]),
    ).map((issue) => normalizeIssue(issue));
  }

  async recoverOwnedClaims(
    owner: string,
    activeClaimIds: ReadonlySet<string>,
  ): Promise<number> {
    const issues = parseIssues(
      await this.run(["list", "--all", "--flat", "--limit", "0", "--json"]),
    );
    let released = 0;
    for (const issue of issues) {
      if (issue.assignee !== owner) continue;
      const claimId = metadataString(issue, BEADS_CLAIM_METADATA.claimId);
      if (claimId && activeClaimIds.has(claimId)) continue;
      const args = [
        "update",
        issue.id,
        "--assignee",
        "",
        "--unset-metadata",
        BEADS_CLAIM_METADATA.candidate,
        "--unset-metadata",
        BEADS_CLAIM_METADATA.claimId,
        "--unset-metadata",
        BEADS_CLAIM_METADATA.expiresAt,
        "--unset-metadata",
        BEADS_CLAIM_METADATA.threadId,
      ];
      if (!(issue.labels ?? []).includes(BEADS_REVIEW_LABEL)) {
        args.push("--status", "open");
      }
      args.push("--actor", owner, "--json");
      await this.run(args);
      released += 1;
    }
    return released;
  }

  async claim(input: BeadsClaimInput): Promise<UnifiedTask | null> {
    await this.run([
      "update",
      input.issueId,
      "--set-metadata",
      `${BEADS_CLAIM_METADATA.candidate}=${input.claimId}`,
      "--json",
    ]);
    let claimed: BeadsIssue | null = null;
    try {
      const candidates = parseIssues(
        await this.run([
        "ready",
        "--claim",
        "--metadata-field",
        `${BEADS_CLAIM_METADATA.candidate}=${input.claimId}`,
        "--limit",
        "1",
        "--actor",
        input.owner,
        "--json",
        ]),
      );
      claimed = candidates.find((issue) => issue.id === input.issueId) ?? null;
    } catch (error) {
      if (error instanceof Error && /already claimed by/u.test(error.message)) {
        claimed = null;
      } else {
        await this.clearCandidate(input.issueId, input.claimId);
        throw error;
      }
    }

    if (!claimed) {
      await this.clearCandidate(input.issueId, input.claimId);
      return null;
    }

    try {
      const stdout = await this.run([
        "update",
        input.issueId,
        "--set-metadata",
        `${BEADS_CLAIM_METADATA.claimId}=${input.claimId}`,
        "--set-metadata",
        `${BEADS_CLAIM_METADATA.expiresAt}=${input.expiresAt}`,
        "--unset-metadata",
        BEADS_CLAIM_METADATA.candidate,
        "--unset-metadata",
        BEADS_CLAIM_METADATA.threadId,
        "--remove-label",
        BEADS_REVIEW_LABEL,
        "--actor",
        input.owner,
        "--json",
      ]);
      return normalizeIssue(parseIssue(stdout));
    } catch (error) {
      await this.run([
        "update",
        input.issueId,
        "--assignee",
        "",
        "--status",
        "open",
        "--unset-metadata",
        BEADS_CLAIM_METADATA.candidate,
        "--actor",
        input.owner,
        "--json",
      ]).catch(() => {});
      throw error;
    }
  }

  async renewClaim(input: BeadsClaimMutation): Promise<boolean> {
    const issue = parseIssue(await this.run(["show", input.issueId, "--json"]));
    if (
      issue.assignee !== input.owner ||
      metadataString(issue, BEADS_CLAIM_METADATA.claimId) !== input.claimId
    ) {
      return false;
    }
    const args = [
      "update",
      input.issueId,
      "--set-metadata",
      `${BEADS_CLAIM_METADATA.expiresAt}=${input.expiresAt}`,
    ];
    if (input.threadId !== undefined) {
      if (input.threadId === null) {
        args.push("--unset-metadata", BEADS_CLAIM_METADATA.threadId);
      } else {
        args.push(
          "--set-metadata",
          `${BEADS_CLAIM_METADATA.threadId}=${input.threadId}`,
        );
      }
    }
    args.push("--actor", input.owner, "--json");
    await this.run(args);
    return true;
  }

  async releaseClaim(
    input: BeadsClaimInput & { resetToQueued: boolean },
  ): Promise<boolean> {
    const issue = parseIssue(await this.run(["show", input.issueId, "--json"]));
    if (
      issue.assignee !== input.owner ||
      metadataString(issue, BEADS_CLAIM_METADATA.claimId) !== input.claimId
    ) {
      return false;
    }
    const args = [
      "update",
      input.issueId,
      "--assignee",
      "",
      "--unset-metadata",
      BEADS_CLAIM_METADATA.candidate,
      "--unset-metadata",
      BEADS_CLAIM_METADATA.claimId,
      "--unset-metadata",
      BEADS_CLAIM_METADATA.expiresAt,
      "--unset-metadata",
      BEADS_CLAIM_METADATA.threadId,
    ];
    if (input.resetToQueued) {
      args.push(
        "--status",
        "open",
        "--remove-label",
        BEADS_REVIEW_LABEL,
      );
    }
    args.push("--actor", input.owner, "--json");
    await this.run(args);
    return true;
  }

  async transitionExecution(id: string, state: TaskStatus): Promise<UnifiedTask> {
    const args = ["update", id, "--status", beadsStatus(state)];
    if (state === "in_review") {
      args.push("--add-label", BEADS_REVIEW_LABEL);
    } else {
      args.push("--remove-label", BEADS_REVIEW_LABEL);
    }
    args.push("--json");
    return normalizeIssue(parseIssue(await this.run(args)));
  }

  async create(input: CreateTaskInput): Promise<UnifiedTask> {
    const args = [
      "create",
      input.title,
      "--json",
      "--priority",
      PRIORITY_TO_BEADS[input.priority ?? "medium"],
      "--type",
      input.type ?? "task",
    ];
    if (input.description) args.push("--description", input.description);
    if (input.parentId) args.push("--parent", input.parentId);
    const stdout = await this.run(args);
    return normalizeIssue(parseIssue(stdout));
  }

  async update(id: string, input: UpdateTaskInput): Promise<UnifiedTask> {
    const current = (await this.list()).find((task) => task.id === id);
    if (!current) throw new Error(`Task not found: ${id}`);
    const args = ["update", id, "--json"];
    if (input.title !== undefined) args.push("--title", input.title);
    if (input.description !== undefined)
      args.push("--description", input.description);
    if (input.nativeStatus !== undefined)
      args.push("--status", input.nativeStatus);
    else if (input.status !== undefined)
      args.push("--status", beadsStatus(input.status));
    if (input.nativeStatus !== undefined || input.status !== undefined) {
      if (input.status === "in_review") {
        args.push("--add-label", BEADS_REVIEW_LABEL);
      } else {
        args.push("--remove-label", BEADS_REVIEW_LABEL);
      }
    }
    if (input.priority !== undefined)
      args.push("--priority", PRIORITY_TO_BEADS[input.priority]);
    if (input.parentId !== undefined)
      args.push("--parent", input.parentId ?? "");
    const stdout = await this.run(args);
    return normalizeIssue(parseIssue(stdout));
  }

  async listComments(id: string): Promise<UnifiedComment[]> {
    return parseComments(await this.run(["comments", id, "--json"]));
  }

  async addComment(
    id: string,
    body: string,
    author: string,
  ): Promise<UnifiedComment> {
    return parseComment(
      await this.run([
        "comments",
        "add",
        id,
        body,
        "--author",
        author,
        "--json",
      ]),
    );
  }

  async getMetadata(id: string, key: string): Promise<string | null> {
    const issue = parseIssue(await this.run(["show", id, "--json"]));
    return metadataString(issue, key);
  }

  async setMetadata(id: string, key: string, value: string | null): Promise<void> {
    const args = ["update", id];
    if (value === null) args.push("--unset-metadata", key);
    else args.push("--set-metadata", `${key}=${value}`);
    args.push("--json");
    await this.run(args);
  }

  async listLinks(id: string): Promise<UnifiedTaskLink[]> {
    const [down, up] = await Promise.all([
      this.run(["dep", "list", id, "--direction", "down", "--json"]),
      this.run(["dep", "list", id, "--direction", "up", "--json"]),
    ]);
    return [...parseLinks(down, "down"), ...parseLinks(up, "up")];
  }

  async addLink(
    id: string,
    linkedId: string,
    type: TaskLinkType,
  ): Promise<void> {
    if (type === "relates-to") {
      await this.run(["dep", "relate", id, linkedId, "--json"]);
      return;
    }
    await this.run([
      "dep",
      "add",
      id,
      linkedId,
      "--type",
      type,
      "--json",
    ]);
  }

  async removeLink(
    id: string,
    linkedId: string,
    type: TaskLinkType,
    direction: "down" | "up",
  ): Promise<void> {
    if (type === "relates-to") {
      await this.run(["dep", "unrelate", id, linkedId, "--json"]);
      return;
    }
    const [issueId, dependencyId] =
      direction === "down" ? [id, linkedId] : [linkedId, id];
    await this.run([
      "dep",
      "remove",
      issueId,
      dependencyId,
      "--json",
    ]);
  }

}
