import type {
  ProjectExecutionPolicy,
  TaskExecutionPolicy,
} from "./types.js";

export function matchesProjectEligibility(
  labels: readonly string[],
  taskPolicy: TaskExecutionPolicy,
  projectPolicy: ProjectExecutionPolicy,
): boolean {
  if (projectPolicy.mode === "off" || taskPolicy === "disabled") return false;
  if (taskPolicy === "enabled") return true;
  if (projectPolicy.mode === "all_todo") return true;
  if (projectPolicy.labelFilter.length === 0) return false;

  const taskLabels = new Set(labels);
  return projectPolicy.labelMatch === "all"
    ? projectPolicy.labelFilter.every((label) => taskLabels.has(label))
    : projectPolicy.labelFilter.some((label) => taskLabels.has(label));
}
