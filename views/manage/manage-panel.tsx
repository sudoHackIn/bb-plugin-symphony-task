import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import type { Folder, Label, Preset, Workflow } from "../../shared/contract.js";
import {
  listAllTasks,
  useFolders,
  usePresets,
  useProjects,
  useTasksQuery,
  useTasksRpc,
  useWorkflows,
} from "../../shell/data.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import {
  PERMISSION_LABELS,
  PERMISSION_MODES,
  PresetDialog,
  describePresetEnvironment,
  savePresetDraft,
  type PresetDraft,
} from "./preset-dialog.js";
import { ColorSwatchPicker, DEFAULT_COLOR } from "./shared.js";
import type { TaskProvidersRpcContract } from "../../providers/contract.js";
import type { TaskProviderId } from "../../providers/contract.js";
import {
  WorkflowDialog,
  type WorkflowDraft,
} from "./workflow-dialog.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function LabelEditorRow({
  initialName,
  initialColor,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  initialColor: string;
  submitLabel: string;
  onSubmit: (name: string, color: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={name}
        placeholder="Label name"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && name.trim() !== "") {
            event.preventDefault();
            void onSubmit(name.trim(), color).then(() => {
              if (!onCancel) {
                setName("");
                setColor(DEFAULT_COLOR);
              }
            });
          }
        }}
        className="h-7 w-44 text-xs"
      />
      <ColorSwatchPicker value={color} onChange={setColor} />
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={name.trim() === ""}
        onClick={() =>
          void onSubmit(name.trim(), color).then(() => {
            if (!onCancel) {
              setName("");
              setColor(DEFAULT_COLOR);
            }
          })
        }
      >
        {submitLabel}
      </Button>
      {onCancel ? (
        <Button size="sm" variant="ghost" className="h-7" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

function LabelsSection() {
  const rpc = useTasksRpc();
  const projects = useProjects();
  const projectList = projects.data ?? [];
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const projectId = selectedProjectId ?? projectList[0]?.id ?? null;
  const labels = useTasksQuery(
    async (rpc) =>
      projectId
        ? (await rpc.call("listLabels", { projectId })).labels
        : ([] as Label[]),
    ["projects:changed"],
    [projectId],
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    label: Label;
    usedBy: number;
  } | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(describeError(actionError));
    }
  };

  const askDelete = (label: Label) =>
    run(async () => {
      const tasks = await listAllTasks(rpc, { labelIds: [label.id] });
      setConfirmDelete({ label, usedBy: tasks.length });
    });

  if (projectList.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Create a project first — labels are project-scoped.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Select
        value={projectId ?? undefined}
        onValueChange={(value) => {
          setSelectedProjectId(value);
          setEditingId(null);
        }}
      >
        <SelectTrigger aria-label="Project" className="h-8 w-56">
          <SelectValue placeholder="Project" />
        </SelectTrigger>
        <SelectContent>
          {projectList.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-2.5 rounded-sm"
                  style={{ backgroundColor: project.color }}
                />
                {project.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="divide-y divide-border-hairline rounded-md border border-border">
        {(labels.data ?? []).map((label) => (
          <div key={label.id} className="px-3 py-2">
            {editingId === label.id ? (
              <LabelEditorRow
                initialName={label.name}
                initialColor={label.color}
                submitLabel="Save"
                onCancel={() => setEditingId(null)}
                onSubmit={(name, color) =>
                  run(async () => {
                    await rpc.call("updateLabel", {
                      labelId: label.id,
                      name,
                      color,
                    });
                    setEditingId(null);
                  })
                }
              />
            ) : (
              <div className="group flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                <span className="flex-1 text-sm">{label.name}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-muted-foreground opacity-0 group-hover:opacity-100"
                  aria-label={`Edit label ${label.name}`}
                  onClick={() => setEditingId(label.id)}
                >
                  <Icon name="Edit" className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                  aria-label={`Delete label ${label.name}`}
                  onClick={() => void askDelete(label)}
                >
                  <Icon name="Trash2" className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
        {(labels.data ?? []).length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No labels yet.
          </p>
        ) : null}
      </div>
      <LabelEditorRow
        initialName=""
        initialColor={DEFAULT_COLOR}
        submitLabel="Add label"
        onSubmit={(name, color) =>
          run(async () => {
            if (!projectId) return;
            await rpc.call("createLabel", { projectId, name, color });
          })
        }
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
        title={`Delete label “${confirmDelete?.label.name ?? ""}”?`}
        description={
          confirmDelete && confirmDelete.usedBy > 0
            ? `Used by ${confirmDelete.usedBy} task${confirmDelete.usedBy > 1 ? "s" : ""} — removing it detaches them.`
            : "This label isn't used by any tasks."
        }
        confirmLabel="Delete label"
        destructive
        onConfirm={() => {
          const target = confirmDelete;
          if (target) {
            void run(() =>
              rpc.call("deleteLabel", { labelId: target.label.id }),
            );
          }
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

function PresetsSection() {
  const rpc = useTasksRpc();
  const presets = usePresets();
  const machines = useTasksQuery(
    async (rpc) => (await rpc.call("listMachines", {})).machines,
    [],
  );
  // Keyed remount resets the dialog draft per open/target.
  const [dialog, setDialog] = useState<{
    key: number;
    editing: Preset | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (editing: Preset | null, draft: PresetDraft) => {
    await savePresetDraft(rpc, editing, draft);
    presets.refresh();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Presets available when dispatching a task to an agent.
        </p>
        <Button
          size="sm"
          className="h-7"
          onClick={() => setDialog({ key: Date.now(), editing: null })}
        >
          <Icon name="Plus" className="size-3.5" />
          New preset
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-hairline text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Provider</th>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Reasoning</th>
              <th className="px-3 py-2 font-medium">Permissions</th>
              <th className="px-3 py-2 font-medium">Environment</th>
              <th className="px-3 py-2 font-medium">Instructions</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-hairline">
            {(presets.data ?? []).map((preset) => {
              const permission = PERMISSION_MODES.find(
                (mode) => mode === preset.permissionMode,
              );
              return (
                <tr key={preset.id} className="group">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <Icon
                        name="Brain"
                        className="size-3.5 text-muted-foreground"
                      />
                      {preset.name}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {preset.providerId}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {preset.modelId}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {preset.reasoningLevel}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {permission
                      ? PERMISSION_LABELS[permission]
                      : preset.permissionMode}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {describePresetEnvironment(preset, machines.data ?? [])}
                  </td>
                  <td
                    className="max-w-48 truncate px-3 py-2 text-xs text-muted-foreground"
                    title={preset.instructions}
                  >
                    {preset.instructions === "" ? "—" : preset.instructions}
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6 text-muted-foreground"
                        aria-label={`Edit preset ${preset.name}`}
                        onClick={() =>
                          setDialog({ key: Date.now(), editing: preset })
                        }
                      >
                        <Icon name="Edit" className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6 text-muted-foreground hover:text-destructive"
                        aria-label={`Delete preset ${preset.name}`}
                        onClick={() => {
                          setError(null);
                          rpc
                            .call("deletePreset", { presetId: preset.id })
                            .then(() => presets.refresh())
                            .catch((deleteError: unknown) =>
                              setError(describeError(deleteError)),
                            );
                        }}
                      >
                        <Icon name="Trash2" className="size-3.5" />
                      </Button>
                    </span>
                  </td>
                </tr>
              );
            })}
            {(presets.data ?? []).length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-3 text-sm text-muted-foreground"
                >
                  No presets yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {dialog ? (
        <PresetDialog
          key={dialog.key}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          editing={dialog.editing}
          onSave={(draft) => save(dialog.editing, draft)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

const NO_WORKFLOW = "__none__";

function WorkflowsSection() {
  const rpc = useTasksRpc();
  const workflows = useWorkflows();
  const projects = useProjects();
  const [dialog, setDialog] = useState<{
    key: number;
    editing: Workflow | null;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async (editing: Workflow | null, draft: WorkflowDraft) => {
    if (editing) {
      await rpc.call("updateWorkflow", {
        workflowId: editing.id,
        name: draft.name,
        markdown: draft.markdown,
      });
    } else {
      await rpc.call("createWorkflow", draft);
    }
    workflows.refresh();
  };

  const assign = async (projectId: string, workflowId: string | null) => {
    setError(null);
    try {
      await rpc.call("updateProject", { projectId, workflowId });
      projects.refresh();
    } catch (assignError) {
      setError(describeError(assignError));
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Reusable Markdown policies that tell dispatched agents how to work
            and when to hand control back to a human.
          </p>
          <Button
            size="sm"
            className="h-7 shrink-0"
            onClick={() => setDialog({ key: Date.now(), editing: null })}
          >
            <Icon name="Plus" className="size-3.5" />
            New workflow
          </Button>
        </div>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border-hairline text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Revision</th>
                <th className="px-3 py-2 font-medium">Projects</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-hairline">
              {(workflows.data ?? []).map((workflow) => {
                const assigned = (projects.data ?? []).filter(
                  (project) => project.workflowId === workflow.id,
                );
                return (
                  <tr key={workflow.id} className="group">
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <Icon name="Workflow" className="size-3.5 text-muted-foreground" />
                        {workflow.name}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {workflow.revision}
                    </td>
                    <td
                      className="max-w-72 truncate px-3 py-2 text-muted-foreground"
                      title={assigned.map((project) => project.name).join(", ")}
                    >
                      {assigned.length === 0
                        ? "—"
                        : assigned.map((project) => project.name).join(", ")}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-6 text-muted-foreground"
                          aria-label={`Edit workflow ${workflow.name}`}
                          onClick={() =>
                            setDialog({ key: Date.now(), editing: workflow })
                          }
                        >
                          <Icon name="Edit" className="size-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-6 text-muted-foreground hover:text-destructive"
                          aria-label={`Delete workflow ${workflow.name}`}
                          onClick={() => setConfirmDelete(workflow)}
                        >
                          <Icon name="Trash2" className="size-3.5" />
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              {(workflows.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-3 text-muted-foreground">
                    No workflows yet. Projects continue using the built-in
                    execution prompt.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Project assignments</h3>
          <p className="text-xs text-muted-foreground">
            A workflow can be shared by any number of projects. Assignment
            changes apply to future agent dispatches.
          </p>
        </div>
        <div className="max-w-2xl divide-y divide-border-hairline rounded-md border border-border">
          {(projects.data ?? []).map((project) => (
            <div
              key={project.id}
              className="flex items-center justify-between gap-4 px-3 py-2"
            >
              <span className="min-w-0 truncate text-sm">{project.name}</span>
              <Select
                value={project.workflowId ?? NO_WORKFLOW}
                onValueChange={(value) =>
                  void assign(
                    project.id,
                    value === NO_WORKFLOW ? null : value,
                  )
                }
              >
                <SelectTrigger className="h-8 w-64">
                  <SelectValue placeholder="No workflow" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_WORKFLOW}>No workflow</SelectItem>
                  {(workflows.data ?? []).map((workflow) => (
                    <SelectItem key={workflow.id} value={workflow.id}>
                      {workflow.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
          {(projects.data ?? []).length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              Create a project before assigning a workflow.
            </p>
          ) : null}
        </div>
      </section>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {dialog ? (
        <WorkflowDialog
          key={dialog.key}
          open
          editing={dialog.editing}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onSave={(draft) => save(dialog.editing, draft)}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
        title={`Delete workflow “${confirmDelete?.name ?? ""}”?`}
        description="Projects using it will return to the built-in execution prompt."
        confirmLabel="Delete workflow"
        destructive
        onConfirm={() => {
          const target = confirmDelete;
          if (!target) return;
          void rpc
            .call("deleteWorkflow", { workflowId: target.id })
            .then(() => {
              workflows.refresh();
              projects.refresh();
            })
            .catch((deleteError: unknown) =>
              setError(describeError(deleteError)),
            );
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

const ROOT_PARENT = "__root__";

function FolderRow({
  folder,
  rootFolders,
  onRename,
  onMove,
}: {
  folder: Folder;
  rootFolders: Folder[];
  onRename: (name: string) => Promise<void>;
  onMove: (parentFolderId: string | null) => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(folder.name);
  const parentOptions = rootFolders.filter((entry) => entry.id !== folder.id);

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Icon name="Folder" className="size-3.5 shrink-0 text-muted-foreground" />
      {renaming ? (
        <>
          <Input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draftName.trim() !== "") {
                event.preventDefault();
                void onRename(draftName.trim()).then(() => setRenaming(false));
              }
              if (event.key === "Escape") setRenaming(false);
            }}
            className="h-7 w-44 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={draftName.trim() === ""}
            onClick={() =>
              void onRename(draftName.trim()).then(() => setRenaming(false))
            }
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => setRenaming(false)}
          >
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span className="flex-1 truncate text-sm">{folder.name}</span>
          <Select
            value={folder.parentFolderId ?? ROOT_PARENT}
            onValueChange={(value) =>
              void onMove(value === ROOT_PARENT ? null : value)
            }
          >
            <SelectTrigger
              aria-label={`Parent of ${folder.name}`}
              className="h-7 w-40 text-xs text-muted-foreground"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROOT_PARENT}>Top level</SelectItem>
              {parentOptions.map((parent) => (
                <SelectItem key={parent.id} value={parent.id}>
                  {parent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground"
            aria-label={`Rename folder ${folder.name}`}
            onClick={() => {
              setDraftName(folder.name);
              setRenaming(true);
            }}
          >
            <Icon name="Edit" className="size-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

function FoldersSection() {
  const rpc = useTasksRpc();
  const folders = useFolders();
  const [error, setError] = useState<string | null>(null);
  const folderList = folders.data ?? [];
  // The sidebar nests folders one level deep, so only roots can be parents.
  const rootFolders = useMemo(
    () => folderList.filter((folder) => folder.parentFolderId === null),
    [folderList],
  );

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(describeError(actionError));
    }
  };

  return (
    <div className="space-y-3">
      {folderList.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No folders yet — create one from the New project dialog.
        </p>
      ) : (
        <div className="divide-y divide-border-hairline rounded-md border border-border">
          {folderList.map((folder) => (
            <FolderRow
              key={folder.id}
              folder={folder}
              rootFolders={rootFolders}
              onRename={(name) =>
                run(() =>
                  rpc.call("renameFolder", { folderId: folder.id, name }),
                )
              }
              onMove={(parentFolderId) =>
                run(() =>
                  rpc.call("moveFolder", {
                    folderId: folder.id,
                    parentFolderId,
                  }),
                )
              }
            />
          ))}
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

function ProjectsSection() {
  const rpc = useTasksRpc();
  const projects = useProjects();
  const [confirm, setConfirm] = useState<{
    project: (NonNullable<typeof projects.data>)[number];
    taskCount: number | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const askDelete = (project: NonNullable<typeof projects.data>[number]) => {
    setError(null);
    // Confirmation must stay available even when Jira/Beads is offline.
    setConfirm({ project, taskCount: null });
  };

  const remove = async () => {
    if (!confirm) return;
    const projectId = confirm.project.id;
    setBusyId(projectId);
    setError(null);
    try {
      const result = await rpc.call("deleteProject", { projectId, force: true });
      if (!result.ok) throw new Error(result.error.message);
      setConfirm(null);
    } catch (deleteError) {
      setError(describeError(deleteError));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-xl space-y-3">
      <p className="text-sm text-muted-foreground">
        Deleting a Tasks project does not delete issues in Jira or Beads.
      </p>
      <div className="divide-y divide-border-hairline rounded-md border border-border">
        {(projects.data ?? []).map((project) => (
          <div key={project.id} className="flex items-center gap-2 px-3 py-2">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: project.color }}
            />
            <span className="min-w-0 flex-1 truncate text-sm">{project.name}</span>
            <span className="text-xs text-muted-foreground">{project.prefix}</span>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground hover:text-destructive"
              aria-label={`Delete project ${project.name}`}
              disabled={busyId === project.id}
              onClick={() => askDelete(project)}
            >
              <Icon name="Trash2" className="size-3.5" />
            </Button>
          </div>
        ))}
        {(projects.data ?? []).length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">No projects yet.</p>
        ) : null}
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={`Delete ${confirm?.project.name ?? "project"}?`}
        description={
          confirm?.taskCount
            ? `This removes the Tasks project and ${confirm.taskCount} local task reference${confirm.taskCount === 1 ? "" : "s"}. Jira and Beads issues remain untouched.`
            : "This removes the Tasks project. Jira and Beads issues remain untouched."
        }
        confirmLabel="Delete project"
        destructive
        onConfirm={() => void remove()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function SourcesSection() {
  const rpc = useRpc<TaskProvidersRpcContract>();
  const projects = useProjects();
  const projectList = projects.data ?? [];
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const projectId = selectedProjectId ?? projectList[0]?.id ?? null;
  const [state, setState] = useState<{
    selected: TaskProviderId;
    jiraJql: string;
    providers: Array<{
      id: TaskProviderId;
      name: string;
      available: boolean;
      detail: string;
      readOnly: boolean;
    }>;
  } | null>(null);
  const [provider, setProvider] = useState<TaskProviderId>("local");
  const [jiraJql, setJiraJql] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setState(null);
      return;
    }
    let active = true;
    setError(null);
    void rpc.call("getProjectTaskProvider", { projectId }).then(
      (next) => {
        if (!active) return;
        setState(next);
        setProvider(next.selected);
        setJiraJql(next.jiraJql);
      },
      (loadError: unknown) => {
        if (active) setError(describeError(loadError));
      },
    );
    return () => {
      active = false;
    };
  }, [projectId, rpc]);

  if (projectList.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Create a project first — sources are configured per project.
      </p>
    );
  }

  const save = async () => {
    if (!projectId || saving) return;
    setSaving(true);
    setError(null);
    try {
      await rpc.call("setProjectTaskProvider", {
        projectId,
        provider,
        jiraJql,
      });
      const next = await rpc.call("getProjectTaskProvider", { projectId });
      setState(next);
      setProvider(next.selected);
      setJiraJql(next.jiraJql);
    } catch (saveError) {
      setError(describeError(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xl space-y-4">
      <Select value={projectId ?? undefined} onValueChange={setSelectedProjectId}>
        <SelectTrigger aria-label="Project" className="h-8 w-56">
          <SelectValue placeholder="Project" />
        </SelectTrigger>
        <SelectContent>
          {projectList.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-2.5 rounded-sm"
                  style={{ backgroundColor: project.color }}
                />
                {project.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="task-source">
          Task source
        </label>
        <Select value={provider} onValueChange={(value) => setProvider(value as TaskProviderId)}>
          <SelectTrigger id="task-source" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(state?.providers ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id} disabled={!item.available}>
                {item.name}{item.readOnly ? " · read-only" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {state?.providers.find((item) => item.id === provider)?.detail ?? "Loading…"}
        </p>
      </div>

      {provider === "jira" ? (
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="jira-jql">
            JQL for this project
          </label>
          <Input
            id="jira-jql"
            value={jiraJql}
            onChange={(event) => setJiraJql(event.target.value)}
            placeholder="project = TEAM ORDER BY updated DESC"
          />
        </div>
      ) : null}

      <Button size="sm" disabled={!state || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save source"}
      </Button>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Settings-ish management surface: labels, agent presets, and folders.
 *
 * The shell does not yet reserve a manage route or sidebar-footer slot, so
 * this is exported unmounted; when the shell grows one (e.g. a `manage`
 * subPath or a sidebar "Manage" button), render <ManagePanel /> there.
 */
export function ManagePanel({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4",
        className,
      )}
    >
      <header className="space-y-1">
        <h2 className="text-base font-semibold">Manage</h2>
        <p className="text-sm text-muted-foreground">
          Projects, sources, workflows, labels, agent presets, and folders.
        </p>
      </header>
      <Tabs defaultValue="sources">
        <TabsList>
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="workflows">Workflows</TabsTrigger>
          <TabsTrigger value="labels">Labels</TabsTrigger>
          <TabsTrigger value="presets">Presets</TabsTrigger>
          <TabsTrigger value="folders">Folders</TabsTrigger>
        </TabsList>
        <TabsContent value="projects" className="pt-3">
          <ProjectsSection />
        </TabsContent>
        <TabsContent value="sources" className="pt-3">
          <SourcesSection />
        </TabsContent>
        <TabsContent value="workflows" className="pt-3">
          <WorkflowsSection />
        </TabsContent>
        <TabsContent value="labels" className="pt-3">
          <LabelsSection />
        </TabsContent>
        <TabsContent value="presets" className="pt-3">
          <PresetsSection />
        </TabsContent>
        <TabsContent value="folders" className="pt-3">
          <FoldersSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
