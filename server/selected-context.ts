import { projectMappingSchema } from "../shared/config";
import { taskContextMetadataSchema, type PersistedTaskContext, type TaskContextSnapshot } from "../shared/task-context";
import type { ExperienceContext } from "./experience";
import { ConfigurationError } from "./errors";
import { RequestError } from "./protocol";

function metadata(snapshot: PersistedTaskContext | TaskContextSnapshot) {
  return taskContextMetadataSchema.parse({ ...snapshot, assetCount: snapshot.assets.length, textChars: snapshot.text.length });
}

export async function selectedExecutionContext(context: ExperienceContext, key: string) {
  const record = context.storage.get(key);
  if (!record || record.serverUrl !== context.config.serverUrl) throw new ConfigurationError("This execution is unavailable in the current It's a Plan connection");
  const captured = record.taskContext ? metadata(record.taskContext) : null;
  if (!record.issueId) return { captured, latest: null, checkedAt: Date.now(), warning: "This run has no associated issue development context." };
  try {
    const issue = await context.protocol.issue(record.issueId);
    context.assertCurrent();
    if (String(issue.projectId) !== record.projectId) throw new ConfigurationError("The issue changed project; historical execution context cannot be rerouted");
    const policy = {
      ...(record.projectMapping ?? projectMappingSchema.parse({})),
      taskContext: { enabled: true, development: true, checklists: false, relations: false, documents: false, attachments: false },
    };
    const latest = await context.protocol.context(issue, policy);
    context.assertCurrent();
    return { captured, latest: metadata(latest), checkedAt: Date.now(), warning: null };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    const warning = error instanceof RequestError && [401, 403].includes(error.status)
      ? "Current issue context access was denied. Captured data is historical, not a current observation."
      : "Current issue context is unavailable. Captured data is historical, not proof that no development links exist.";
    context.assertCurrent();
    return { captured, latest: null, checkedAt: Date.now(), warning };
  }
}
