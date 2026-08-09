import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc, useRealtime } from "@bb/plugin-sdk/app";
import type { Task } from "../../shared/contract.js";
import {
  BEADS_LINK_TYPES,
  type TaskProvidersRpcContract,
} from "../../providers/contract.js";
import { listAllTasks, useTasksRpc } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Icon } from "@/components/ui/icon";

type LinkType = (typeof BEADS_LINK_TYPES)[number];
const LINK_TYPE_LABELS: Record<LinkType, string> = {
  blocks: "Blocked by",
  tracks: "Tracks",
  "relates-to": "Related",
};

function linkLabel(type: LinkType, direction: "down" | "up"): string {
  if (type === "blocks") return direction === "down" ? "Blocked by" : "Blocks";
  if (type === "tracks") return direction === "down" ? "Tracks" : "Tracked by";
  return "Related";
}

export function BeadsLinks({
  task,
  onError,
}: {
  task: Task;
  onError: (message: string) => void;
}) {
  const rpc = useRpc<TaskProvidersRpcContract>();
  const tasksRpc = useTasksRpc();
  const navigation = useTasksNavigation();
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [links, setLinks] = useState<
    Array<{
      linkedTaskId: string;
      linkedTaskKey: string;
      linkedTaskTitle: string;
      linkedTaskStatus: string;
      type: LinkType;
      direction: "down" | "up";
    }>
  >([]);
  const [candidates, setCandidates] = useState<Task[]>([]);
  const [type, setType] = useState<LinkType>("blocks");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [linkResult, projectTasks] = await Promise.all([
        rpc.call("listBeadsTaskLinks", {
          taskId: task.id,
          projectId: task.projectId,
        }),
        listAllTasks(tasksRpc, { projectId: task.projectId }),
      ]);
      setLinks(linkResult.links);
      setCandidates(projectTasks.filter((candidate) => candidate.id !== task.id));
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : String(error));
    }
  }, [rpc, task.id, task.projectId, tasksRpc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useRealtime("tasks:changed", () => void refresh());

  const linkedIds = useMemo(
    () => new Set(links.map((link) => link.linkedTaskId)),
    [links],
  );

  const add = async (linkedTaskId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await rpc.call("addBeadsTaskLink", {
        taskId: task.id,
        projectId: task.projectId,
        linkedTaskId,
        type,
      });
      setOpen(false);
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (link: (typeof links)[number]) => {
    if (busy) return;
    setBusy(true);
    try {
      await rpc.call("removeBeadsTaskLink", {
        taskId: task.id,
        projectId: task.projectId,
        linkedTaskId: link.linkedTaskId,
        type: link.type,
        direction: link.direction,
      });
      await refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-5 border-t border-border-hairline pt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Links</h2>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2">
                {LINK_TYPE_LABELS[type]}
                <Icon name="ChevronDown" className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {BEADS_LINK_TYPES.map((candidate) => (
                <DropdownMenuItem key={candidate} onSelect={() => setType(candidate)}>
                  {LINK_TYPE_LABELS[candidate]}
                  {candidate === type ? <Icon name="Check" className="ml-auto size-3.5" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2">
                <Icon name="Plus" className="size-3.5" />
                Add link
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-0">
              <Command>
                <CommandInput placeholder="Search Beads tasks…" />
                <CommandList>
                  <CommandEmpty>No tasks found.</CommandEmpty>
                  <CommandGroup>
                    {candidates.map((candidate) => (
                      <CommandItem
                        key={candidate.id}
                        value={`${candidate.key} ${candidate.title}`}
                        disabled={busy || linkedIds.has(candidate.id)}
                        onSelect={() => void add(candidate.id)}
                      >
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {candidate.key}
                        </span>
                        <span className="truncate">{candidate.title}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {links.length === 0 ? (
        <div className="text-xs text-muted-foreground">No linked tasks.</div>
      ) : (
        <div className="divide-y divide-border-hairline">
          {links.map((link) => (
            <div
              key={`${link.linkedTaskId}:${link.type}:${link.direction}`}
              className="flex min-h-8 items-center gap-2 text-sm"
            >
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {linkLabel(link.type, link.direction)}
              </span>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left hover:underline"
                onClick={() =>
                  navigation.go({
                    kind: "task",
                    taskKey: link.linkedTaskKey,
                    projectId: task.projectId,
                  })
                }
              >
                <span className="mr-1.5 text-xs text-muted-foreground">
                  {link.linkedTaskKey}
                </span>
                {link.linkedTaskTitle}
              </button>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {link.linkedTaskStatus}
              </span>
              <button
                type="button"
                title="Remove link"
                aria-label={`Remove link to ${link.linkedTaskKey}`}
                disabled={busy}
                className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                onClick={() => void remove(link)}
              >
                <Icon name="X" className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
