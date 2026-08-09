import { definePluginApp } from "@bb/plugin-sdk/app";
import { TasksAppShell } from "./shell/app-shell.js";
import { TaskDirectiveCard, TaskEmbedPanel } from "./views/embed/index.js";
import { TaskThreadToastListener } from "./notifications/toast.js";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "tasks",
    title: "Tasks",
    icon: "ListTodo",
    path: "tasks",
    component: TasksAppShell,
  });
  app.slots.threadPanelAction({
    id: "task",
    title: "Task",
    icon: "ListTodo",
    component: TaskEmbedPanel,
  });
  app.slots.messageDirective({ id: "task", component: TaskDirectiveCard });
  // A composer is present on normal thread and new-thread surfaces. Mounting
  // the zero-height listener there keeps task completion toasts active while
  // the user works outside the Tasks panel; TasksAppShell mounts it as well.
  app.composer.customize({
    id: "task-thread-notifications",
    banners: [
      {
        id: "listener",
        chrome: "bare",
        component: TaskThreadToastListener,
      },
    ],
  });
});
