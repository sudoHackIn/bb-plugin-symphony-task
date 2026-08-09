import type {
  CreateTaskInput,
  TaskPriority,
  TaskSource,
  TaskStatus,
  UnifiedTask,
  UpdateTaskInput,
} from "./task-source.js";

interface JiraDocumentNode {
  type?: string;
  text?: string;
  content?: JiraDocumentNode[];
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: JiraDocumentNode | string | null;
    status?: { name?: string; statusCategory?: { key?: string } };
    priority?: { name?: string } | null;
    issuetype?: { name?: string };
    labels?: string[];
    assignee?: { displayName?: string } | null;
    updated?: string;
  };
}

interface JiraSearchResponse {
  issues?: JiraIssue[];
  nextPageToken?: string;
}

function documentText(node: JiraDocumentNode | string | null | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.text) return node.text;
  return (node.content ?? []).map(documentText).join(node.type === "paragraph" ? "" : "\n");
}

function normalizeStatus(issue: JiraIssue): TaskStatus {
  const name = issue.fields.status?.name?.toLowerCase() ?? "";
  const category = issue.fields.status?.statusCategory?.key;
  if (name.includes("block")) return "blocked";
  if (category === "done") return "done";
  if (category === "indeterminate") return "in_progress";
  return "backlog";
}

function normalizePriority(name: string | undefined): TaskPriority {
  const value = name?.toLowerCase() ?? "";
  if (value.includes("highest") || value.includes("urgent")) return "urgent";
  if (value.includes("high")) return "high";
  if (value.includes("medium")) return "medium";
  if (value.includes("low")) return "low";
  return "none";
}

export class JiraTaskSource implements TaskSource {
  readonly id = "jira";

  constructor(
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly apiToken: string,
    private readonly jql: string,
  ) {}

  private get authorization(): string {
    return `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString("base64")}`;
  }

  async list(): Promise<UnifiedTask[]> {
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/rest/api/3/search/jql`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: this.authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jql: this.jql,
          maxResults: 100,
          ...(nextPageToken ? { nextPageToken } : {}),
          fields: [
            "summary",
            "description",
            "status",
            "priority",
            "issuetype",
            "labels",
            "assignee",
            "updated",
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Jira ${response.status}: ${detail.slice(0, 500)}`);
      }
      const page = (await response.json()) as JiraSearchResponse;
      issues.push(...(page.issues ?? []));
      nextPageToken = page.nextPageToken;
    } while (nextPageToken && issues.length < 1000);

    return issues.map((issue) => ({
      id: issue.id,
      sourceId: this.id,
      key: issue.key,
      title: issue.fields.summary ?? issue.key,
      description: documentText(issue.fields.description),
      status: normalizeStatus(issue),
      nativeStatus: issue.fields.status?.name ?? "Unknown",
      priority: normalizePriority(issue.fields.priority?.name),
      type: issue.fields.issuetype?.name ?? "Task",
      labels: issue.fields.labels ?? [],
      assignee: issue.fields.assignee?.displayName ?? null,
      externalRef: `${this.baseUrl.replace(/\/$/, "")}/browse/${issue.key}`,
      parentId: null,
      blockedByIds: [],
      updatedAt: issue.fields.updated ?? new Date(0).toISOString(),
      readOnly: true,
    }));
  }

  async create(_input: CreateTaskInput): Promise<UnifiedTask> {
    throw new Error("Jira is read-only in this MVP");
  }

  async update(_id: string, _input: UpdateTaskInput): Promise<UnifiedTask> {
    throw new Error("Jira is read-only in this MVP");
  }
}
