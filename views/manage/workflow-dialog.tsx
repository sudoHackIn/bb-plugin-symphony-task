import { useEffect, useState } from "react";
import type { Workflow } from "../../shared/contract.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "./shared.js";

const DEFAULT_WORKFLOW = `# Standard delivery

This policy describes how agents work on tasks in this project. Task statuses
are the durable state machine; move the task as described below.

## Todo

Move the task to In Progress and begin work. Read the description, recent
comments, attachments, and repository instructions before changing code.

For a large or ambiguous task, create a plan first. If the plan needs a human
decision, attach or comment the plan and move the task to In Review.

## In Progress

Implement the task, run the relevant checks, and review the result. Address
verified findings, then leave a concise review comment with the result,
evidence, and the question or decision needed from the human reviewer. Move
the task to In Review. Never mark the task Done yourself.

## In Review

Do not continue. A human either marks the task Done or returns it to Todo with
rework instructions.

## Returned to Todo (rework)

When a human moves the task back to Todo, treat the latest comments as rework
instructions. Continue from the existing workspace, revalidate, and return the
task to In Review.

## Done or Canceled

Do nothing.`;

export interface WorkflowDraft {
  name: string;
  markdown: string;
}

export function WorkflowDialog({
  open,
  onOpenChange,
  editing,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Workflow | null;
  onSave: (draft: WorkflowDraft) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [markdown, setMarkdown] = useState(DEFAULT_WORKFLOW);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setMarkdown(editing?.markdown ?? DEFAULT_WORKFLOW);
    setError(null);
  }, [editing, open]);

  const submit = async () => {
    if (name.trim() === "" || markdown.trim() === "" || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), markdown: markdown.trim() });
      onOpenChange(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{editing ? "Edit workflow" : "New workflow"}</DialogTitle>
          <DialogDescription>
            Reusable Markdown policy appended to every dispatched agent prompt.
            Task statuses remain the durable workflow state.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Standard delivery"
            />
          </Field>
          <Field
            label="Workflow Markdown"
            hint="Describe behavior by task status, handoff rules, checks, and when the agent must wait for a human."
          >
            <Textarea
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
              className="min-h-[420px] resize-y font-mono text-xs leading-5"
              spellCheck={false}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={name.trim() === "" || markdown.trim() === "" || saving}
            onClick={() => void submit()}
          >
            {saving ? "Saving…" : editing ? "Save workflow" : "Create workflow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
