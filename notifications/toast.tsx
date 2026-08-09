import { useRef } from "react";
import { useBbNavigate, useRealtime } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import {
  TASK_THREAD_IDLE_CHANNEL,
  taskThreadIdleNotificationSchema,
} from "./contract.js";
import { PANEL_PATH, tasksRouteToSubPath } from "../shell/routes.js";

const MAX_SEEN_EVENTS = 256;
const seenEvents = new Set<string>();

function markEventSeen(eventId: string): boolean {
  if (seenEvents.has(eventId)) return false;
  seenEvents.add(eventId);
  if (seenEvents.size > MAX_SEEN_EVENTS) {
    const oldest = seenEvents.values().next().value;
    if (oldest !== undefined) seenEvents.delete(oldest);
  }
  return true;
}

/**
 * Listens for tracked task threads settling and forwards them to bb's host
 * toaster. The same listener may be mounted by multiple composer/panel
 * surfaces in one window, so event ids are deduplicated at module scope.
 */
export function TaskThreadToastListener() {
  const navigate = useBbNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useRealtime(TASK_THREAD_IDLE_CHANNEL, (payload) => {
    const parsed = taskThreadIdleNotificationSchema.safeParse(payload);
    if (!parsed.success || !markEventSeen(parsed.data.eventId)) return;

    for (const task of parsed.data.tasks) {
      toast.success(`${task.key}: agent finished`, {
        description: `${task.title} · ${parsed.data.threadTitle}`,
        action: {
          label: "Open task",
          onClick: () =>
            navigateRef.current.toPluginPanel(PANEL_PATH, {
              subPath: tasksRouteToSubPath({
                kind: "task",
                taskKey: task.key,
                projectId: task.projectId,
              }),
            }),
        },
      });
    }
  });

  return null;
}
