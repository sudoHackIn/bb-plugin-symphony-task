# Symphony Task for bb

Symphony Task brings Local, Beads, and Jira tasks into one BB workspace and
adds an opt-in execution engine for autonomous BB workers.
Its shell, sidebar, list, board, task detail, editor, dialogs, and management
screens follow the same UI and interaction model as BB Tasks.

## Source model

Every Tasks project has one task source:

- **Local Tasks** stores tasks in the plugin's SQLite database.
- **Beads** uses the Beads workspace in the linked bb project's local source.
- **Jira Cloud** presents the issues matching a project-specific JQL query as a
  read-only Tasks view.

New projects explicitly choose **Local Tasks**, **Beads**, or **Jira** in the
creation dialog. The source can later be changed under **Tasks → Manage →
Sources**. Legacy projects with no saved source retain the original automatic
behavior: the plugin selects Beads if the linked bb project contains a Beads
workspace; otherwise it uses Local Tasks. It never scans unrelated bb projects
and never initializes Beads automatically.

Removing a Tasks project only removes its local view, bindings, and task
references. It never deletes issues from Beads or Jira.

## Provider capabilities

| Capability | Local Tasks | Beads | Jira Cloud |
|---|---:|---:|---:|
| List and search tasks | Yes | Yes | Yes |
| Create tasks | Yes | Yes | No |
| Edit title, description, or priority | Yes | Yes | No |
| Change status / move on board | Yes | Yes | No |
| Parent tasks and subtasks | Yes | Yes | No |
| Read labels | Yes | Yes | Yes |
| Edit labels | Yes | No | No |
| Read and add comments | Yes | Yes | No |
| Dependencies and task links | No | Yes | No |
| Delete tasks | Yes | No | No |
| Provider-backed attachments | Yes | No | No |

All sources can use bb execution targets, agent presets, dispatch, and attached
threads. Those are local orchestration features and do not require mutating the
provider issue.

### Beads

Beads is the read/write source for repositories that keep their work tracker
alongside the code. The integration:

- discovers a Beads workspace only through the Tasks project's linked bb
  project;
- invokes `bd` directly without a shell;
- lists, creates, and updates issues;
- preserves native Beads statuses and maps them into the shared Tasks board;
- supports parent/child tasks, comments, and `blocks`, `tracks`, and
  `relates-to` dependency links;
- prevents a blocked issue from being moved to `in_progress` until its blockers
  are resolved;
- uses the Beads database or version-control revision to avoid reloading an
  unchanged issue list.

Beads deletion, label mutation, and provider-backed attachments are not
supported. Attachments or other local orchestration metadata must not be
expected to synchronize into Beads.

Beads uses `bd` from `PATH` by default. Set `beadsExecutable` to use a different
command name or an absolute executable path.

### Jira Cloud

Jira is intentionally a read-only source. A Jira-backed Tasks project is a
saved Jira view, normally one JQL filter, rather than a synchronized copy of a
Jira project. Issues are queried directly and are not imported into Local Tasks
or Beads.

The integration reads up to 1,000 matching issues and maps these Jira fields
into the shared Tasks model:

- key and summary;
- description;
- workflow status and status category;
- priority and issue type;
- labels and assignee;
- last-updated time and the link to the issue in Jira.

The plugin does not create, edit, transition, comment on, link, attach files to,
or delete Jira issues. Controls inherited from the shared Tasks UI may remain
visible, but mutation attempts are rejected as read-only. Jira changes must be
made in Jira itself.

One Jira connection is configured globally for the plugin. Each Tasks project
selecting Jira stores its own JQL query, so several views can share the same
Jira site and credentials.

#### Refresh behavior

Jira currently has no webhook subscription or periodic background polling.
Fresh provider data is requested when:

- the Tasks panel is opened or the page is reloaded;
- the user presses the Tasks refresh button;
- the bb realtime connection reconnects.

These refreshes clear the external-source cache before fetching. Between
refreshes, concurrent reads are coalesced and Jira results use a short
five-second in-memory cache to avoid issuing duplicate requests for the list,
board, sidebar, and task detail views.

## Jira configuration

Open **Settings → Plugins → Symphony Task**, or use:

```sh
bb plugin config symphony-task set jiraBaseUrl https://company.atlassian.net
bb plugin config symphony-task set jiraEmail me@company.com
bb plugin config symphony-task set jiraApiToken YOUR_TOKEN
bb plugin reload symphony-task
```

The API token is a secret plugin setting and is never sent to the frontend.
Jira uses Basic authentication over HTTPS and Atlassian's enhanced
`POST /rest/api/3/search/jql` endpoint with `nextPageToken` pagination.

## Execution targets

A task source and an execution target answer different questions:

- the source determines where the task comes from;
- execution targets determine which bb projects agents work in.

Each task can select one or more bb projects. Dispatch creates one agent thread
per selected target, so a single Jira issue can be worked on across several
microservices without giving the plugin write access to Jira. Local and Beads
tasks inherit their Tasks project's linked bb project until task-specific
targets are saved.

## Autonomous execution

The **Execution** screen controls the local-trackers execution engine:

- the engine is paused after installation and never claims work implicitly;
- global and per-project worker limits bound concurrent BB threads;
- every project starts in `off`, then can use `opt-in` or `all Todo` mode;
- a per-task override can inherit, always run, or never run;
- an agent preset selects the provider, model, permissions, and worktree;
- global and per-project token budgets are enforced from BB token-usage
  events. Enforcement is best-effort and may overshoot slightly between an
  event and the polling cycle that stops the thread;
- runs release their claim when the task reaches review. Moving the task back
  to Todo makes it eligible for a new execution.

Only projects explicitly using **Local Tasks** are executable in this first
version. Beads and Jira remain tracker adapters in the UI, but autonomous
claims stay disabled until their distributed claim semantics are implemented.

## Development

```sh
npm install
npm run typecheck
npm run build
bb plugin install .
```

During development, use `bb plugin dev` or rebuild and run
`bb plugin reload symphony-task`.
