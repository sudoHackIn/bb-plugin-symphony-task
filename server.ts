import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import { createStore } from "./api";
import { registerAttachments } from "./attachments";
import { registerTasksCli } from "./cli";
import { registerDelegation } from "./delegate";
import { registerLifecycle } from "./lifecycle";
import { registerMentions } from "./mentions";
import { registerProviderAwareTasksApi } from "./providers/api";
import { registerExecution } from "./execution/index";
import { registerOpenSpecWorkflow } from "./workflows/index";

export const TASKS_PLUGIN_NAME = "Symphony Task";
export const TASKS_PLUGIN_VERSION = "0.2.0";

export const tasksRpcContract = defineRpcContract({
  ping: {
    input: z.null(),
    output: z.object({ ok: z.literal(true), version: z.string() }),
  },
});

function statusPayload() {
  return { name: TASKS_PLUGIN_NAME, version: TASKS_PLUGIN_VERSION };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info(`${TASKS_PLUGIN_NAME} ${TASKS_PLUGIN_VERSION} loaded`);

  // Connection credentials are global; choosing a task provider remains a
  // project-level concern in the Tasks UI.
  const settings = bb.settings.define({
    beadsExecutable: {
      type: "string",
      label: "Beads executable",
      description: "Command name from PATH or an absolute executable path.",
      default: "bd",
    },
    jiraBaseUrl: {
      type: "string",
      label: "Jira Cloud URL",
      default: "",
    },
    jiraEmail: {
      type: "string",
      label: "Jira account email",
      default: "",
    },
    jiraApiToken: {
      type: "string",
      label: "Jira API token",
      secret: true,
    },
    maxImplementationAttempts: {
      type: "string",
      label: "Maximum automatic implementation attempts",
      description: "After this many failed implementation reviews, wait for a human decision instead of retrying automatically.",
      default: "3",
    },
  });

  const store = createStore(bb);
  const tasksDomain = registerProviderAwareTasksApi(bb, store, settings);
  registerOpenSpecWorkflow(bb, store, tasksDomain.workflowBeads, {
    async maxImplementationAttempts() {
      const value = Number.parseInt((await settings.get()).maxImplementationAttempts, 10);
      return Number.isSafeInteger(value) && value >= 1 && value <= 20 ? value : 3;
    },
  });
  registerAttachments(bb, store.tasks);
  registerTasksCli(bb, store, statusPayload(), tasksDomain);
  registerDelegation(bb, store);
  registerMentions(bb, store);
  await registerLifecycle(bb, store);
  registerExecution(bb, store);

  bb.rpc.register(tasksRpcContract, {
    ping(): { ok: true; version: string } {
      return { ok: true, version: TASKS_PLUGIN_VERSION };
    },
  });
}
