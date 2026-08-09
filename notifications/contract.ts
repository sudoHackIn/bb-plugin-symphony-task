import { z } from "zod";

export const TASK_THREAD_IDLE_CHANNEL = "task-thread:idle";

export const taskThreadIdleNotificationSchema = z
  .object({
    eventId: z.string().min(1),
    threadId: z.string().startsWith("thr_"),
    threadTitle: z.string().min(1),
    tasks: z
      .array(
        z
          .object({
            id: z.string().min(1),
            key: z.string().min(1),
            title: z.string().min(1),
            projectId: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type TaskThreadIdleNotification = z.infer<
  typeof taskThreadIdleNotificationSchema
>;
