import { useCallback, useEffect, useMemo, useState } from "react";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useBotRpc as useRpc } from "./bot-context";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import type { ProjectMapping } from "../shared/config";
import type { Provider } from "../shared/models";
import { customFieldsRpc } from "../shared/rpc";
import { contextLimits, fieldBindingsSchema, taskContextOptionsSchema, type CustomField, type FieldBinding, type TaskContextOptions } from "../shared/task-context";
import { errorMessage, Feedback, RefreshButton, useResource } from "./common";

type FieldCatalog = { scope: number | null; fields?: CustomField[]; error?: string };
const sections: { key: Exclude<keyof TaskContextOptions, "enabled">; label: string; hint: string }[] = [
  { key: "checklists", label: "Checklists", hint: "Read checklist text and completion state. Never tick items automatically." },
  { key: "relations", label: "Relations and subtasks", hint: `Read task-related items, up to ${contextLimits.relations} relations.` },
  { key: "documents", label: "Linked documents", hint: `Read up to ${contextLimits.documents} explicitly linked documents with existing access. No private-document traversal.` },
  { key: "attachments", label: "Attachments", hint: "Read supported text and PDF content and deliver supported images. Scanned PDFs and images are not OCRed." },
  { key: "development", label: "Development links", hint: "Include linked development metadata. Links do not prove implementation or test completion." },
];

function bindingError(binding: FieldBinding, projectId: number, catalog: FieldCatalog | undefined, providers: Provider[]): string | undefined {
  if (binding.projectId !== projectId) return `Saved project ID ${binding.projectId} does not match project ${projectId}. Remove this binding.`;
  if (!catalog) return "Loading the exact field scope before this binding can be applied.";
  if (catalog.error) return catalog.error;
  const field = catalog.fields?.find((item) => item.id === binding.fieldId && item.issueTypeId === binding.issueTypeId);
  if (!field) return "The saved field is unavailable in its exact project and issue-type scope. Remove this binding or restore access.";
  if (field.fieldType !== "select" && field.fieldType !== "multi_select") return "Only select and multi-select fields can choose an agent.";
  if (!field.options.some((option) => option.id === binding.optionId)) return "The saved field option is unavailable. Remove this binding or restore the option.";
  const provider = providers.find((item) => item.id === binding.provider);
  if (!provider?.available || provider.error) return provider?.error || "The saved provider is unavailable. Choose an available native provider.";
  if (binding.model && !provider.models.some((model) => model.id === binding.model)) return "The saved model is unavailable. Choose a discovered model or inherit a compatible model.";
}

export function ContextSettings({ projectId, mapping, onChange, providers, disabled, onValidationChange, ...props }: PluginSurfaceProps & {
  projectId: number;
  mapping: ProjectMapping;
  onChange(patch: Partial<ProjectMapping>): void;
  providers: Provider[];
  disabled: boolean;
  onValidationChange?(error?: string): void;
}) {
  const context = mapping.taskContext || taskContextOptionsSchema.parse({});
  const bindings = mapping.fieldBindings;
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const needsCatalog = fieldsOpen || !!bindings?.length;
  const [scopeText, setScopeText] = useState("");
  const [scope, setScope] = useState<number | null>(null);
  const [fieldId, setFieldId] = useState("");
  const [optionId, setOptionId] = useState("");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const fieldsRpc = useRpc(customFieldsRpc);
  const validProject = Number.isSafeInteger(projectId) && projectId > 0;
  const scopeInput = scopeText.trim();
  const parsedScope = Number(scopeInput);
  const validScope = !scopeInput || /^\d+$/.test(scopeInput) && Number.isSafeInteger(parsedScope) && parsedScope > 0;
  const scopesKey = JSON.stringify(Array.from(new Set([...(fieldsOpen ? [scope] : []), ...(bindings || []).map((binding) => binding.issueTypeId)])).sort((a, b) => (a || 0) - (b || 0)));
  const load = useCallback(async () => {
    if (!needsCatalog) return { projectId, scopesKey, catalogs: [] };
    const scopes: (number | null)[] = JSON.parse(scopesKey);
    const catalogs = await Promise.all(scopes.map(async (scope): Promise<FieldCatalog> => {
      if (!validProject) return { scope, error: "A positive numeric project ID is required." };
      try {
        const fields = await fieldsRpc({ projectId, ...(scope === null ? {} : { issueTypeId: scope }) });
        return { scope, fields };
      } catch (error) { return { scope, error: errorMessage(error) }; }
    }));
    return { projectId, scopesKey, catalogs };
  }, [fieldsRpc, projectId, scopesKey, validProject, needsCatalog]);
  const resource = useResource(load);
  const catalogs = resource.data?.projectId === projectId && resource.data.scopesKey === scopesKey ? resource.data.catalogs : [];
  const catalog = catalogs.find((item) => item.scope === scope);
  const fields = (catalog?.fields || []).filter((field) => field.issueTypeId === scope && (field.fieldType === "select" || field.fieldType === "multi_select"));
  const field = fields.find((item) => String(item.id) === fieldId);
  const provider = providers.find((item) => item.id === providerId && item.available && !item.error);
  const errors = (bindings || []).map((binding) => bindingError(binding, projectId, catalogs.find((item) => item.scope === binding.issueTypeId), providers));
  const validation = fieldBindingsSchema.safeParse(bindings || []);
  const schemaError = validation.success ? undefined : validation.error.issues.map((issue) => issue.message).join("\n");
  const validationError = schemaError || errors.find(Boolean);
  useEffect(() => { onValidationChange?.(validationError); }, [onValidationChange, validationError]);
  const candidate: FieldBinding = { projectId, issueTypeId: scope, fieldId: Number(fieldId), optionId: Number(optionId), provider: providerId, model: modelId };
  const canAdd = validProject && !!field && !!optionId && !!provider && !bindingError(candidate, projectId, catalog, providers) && fieldBindingsSchema.safeParse([...(bindings || []), candidate]).success;
  const updateBinding = (index: number, patch: Partial<FieldBinding>) => onChange({ fieldBindings: (bindings || []).map((binding, position) => position === index ? { ...binding, ...patch } : binding) });
  const contextInfo = useMemo(() => `Optional context is captured once in a private task snapshot, not reloaded into an approved task. Text is limited to ${contextLimits.chars.toLocaleString()} characters. Supported text, PDFs and images share a ${contextLimits.assets}-asset limit, ${contextLimits.assetBytes / 1_000_000} MB per asset and ${contextLimits.totalAssetBytes / 1_000_000} MB total. Reads are bounded to ${contextLimits.timeoutMs / 1000} seconds. No OCR. Unsupported, denied or truncated context is reported explicitly. Credentials and raw asset URLs are never sent to agents.`, []);
  return <>
    <SettingsSection title="Optional task context" info={contextInfo}>
      <SettingsCard>
        <SettingsSwitch label="Enable optional context" hint="Off unless explicitly enabled for this project. Choose each section separately." value={context.enabled} disabled={disabled} onValueChange={(enabled) => onChange({ taskContext: { ...context, enabled } })} />
        {context.enabled && sections.map(({ key, label, hint }) => <SettingsSwitch key={key} label={label} hint={hint} value={context[key]} disabled={disabled} onValueChange={(value) => onChange({ taskContext: { ...context, [key]: value } })} />)}
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="Field-based agent selection" info="Map an exact field option to a native provider and optional model. No fields are suggested or imported automatically. Project-wide fields are the default. Issue overrides and explicit manual choices take precedence. Repository and permission mode cannot be mapped." trailing={fieldsOpen ? <RefreshButton theme={props.theme} label="Refresh project field catalog" disabled={disabled || resource.loading} onPress={resource.refresh} /> : undefined}>
      <SettingsCard><SettingsAction label="Field option mappings" hint={bindings?.length ? `${bindings.length} configured` : "Not configured"} actionLabel={fieldsOpen ? "Hide controls" : "Configure"} disabled={disabled} onPress={() => setFieldsOpen((open) => !open)} /></SettingsCard>
      {fieldsOpen && <>
      <SettingsCard>
        <SettingsInput label="Issue type ID" hint="Blank loads project-wide fields. Enter a positive numeric issue type ID to load only that scope." initialValue="" disabled={disabled} onChangeText={setScopeText} error={validScope ? undefined : "Enter a positive whole-number issue type ID or leave blank."} />
        <SettingsAction label="Field catalog scope" hint={scope === null ? "Project-wide fields" : `Issue type ID ${scope}`} actionLabel="Load fields" disabled={disabled || !validScope || !validProject} onPress={() => { setScope(scopeInput ? parsedScope : null); setFieldId(""); setOptionId(""); resource.refresh(); }} />
        <SettingsSelect label="Field" value={fieldId} options={[{ value: "", label: "Choose a field" }, ...fields.map((item) => ({ value: String(item.id), label: `${item.name} · ID ${item.id}` }))]} disabled={disabled || resource.loading || !!catalog?.error} onValueChange={(value) => { setFieldId(value); setOptionId(""); }} />
        <SettingsSelect label="Field option" value={optionId} options={[{ value: "", label: "Choose an option" }, ...(field?.options || []).map((option) => ({ value: String(option.id), label: `${option.value} · ID ${option.id}` }))]} disabled={disabled || !field} onValueChange={setOptionId} />
        <SettingsSelect label="Provider" value={providerId} options={[{ value: "", label: "Choose a provider" }, ...providers.filter((item) => item.available && !item.error).map((item) => ({ value: item.id, label: item.id }))]} disabled={disabled} onValueChange={(value) => { setProviderId(value); setModelId(""); }} />
        <SettingsSelect label="Model" value={modelId} options={[{ value: "", label: "Inherit compatible model" }, ...(provider?.models || []).map((item) => ({ value: item.id, label: item.name }))]} disabled={disabled || !provider} onValueChange={setModelId} />
        <SettingsAction label="Field option binding" hint="Adds only this selected option to the draft." actionLabel="Add binding" disabled={disabled || resource.loading || !canAdd} onPress={() => onChange({ fieldBindings: [...(bindings || []), candidate] })} />
      </SettingsCard>
      <Feedback theme={props.theme} error={resource.error || catalog?.error || (!validProject ? "A positive numeric project ID is required." : undefined)} message={resource.loading ? "Loading field catalogs…" : catalog?.fields && !fields.length ? "No select or multi-select fields are available in this exact scope." : undefined} />
      {(bindings || []).map((binding, index) => {
        const savedCatalog = catalogs.find((item) => item.scope === binding.issueTypeId);
        const savedField = savedCatalog?.fields?.find((item) => item.id === binding.fieldId && item.issueTypeId === binding.issueTypeId);
        const savedOption = savedField?.options.find((item) => item.id === binding.optionId);
        const savedProvider = providers.find((item) => item.id === binding.provider);
        const providerOptions = providers.filter((item) => item.available && !item.error).map((item) => ({ value: item.id, label: item.id }));
        if (!providerOptions.some((item) => item.value === binding.provider)) providerOptions.push({ value: binding.provider, label: `${binding.provider} (saved, unavailable)` });
        const modelOptions = [{ value: "", label: "Inherit compatible model" }, ...(savedProvider?.models || []).map((item) => ({ value: item.id, label: item.name }))];
        if (binding.model && !modelOptions.some((item) => item.value === binding.model)) modelOptions.push({ value: binding.model, label: `${binding.model} (saved, unavailable)` });
        return <SettingsCard key={`${index}/${binding.projectId}/${binding.issueTypeId}/${binding.fieldId}/${binding.optionId}`}>
          <SettingsRow label={`${savedField?.name || `Field ${binding.fieldId}`} · ${savedOption?.value || `Option ${binding.optionId}`}`} hint={`Project ID ${binding.projectId} · ${binding.issueTypeId === null ? "Project-wide" : `Issue type ID ${binding.issueTypeId}`} · Field ID ${binding.fieldId} · Option ID ${binding.optionId}`} error={errors[index]} />
          <SettingsSelect label="Binding provider" value={binding.provider} options={providerOptions} disabled={disabled} onValueChange={(provider) => updateBinding(index, { provider, model: "" })} />
          <SettingsSelect label="Binding model" value={binding.model} options={modelOptions} disabled={disabled || !savedProvider?.available} onValueChange={(model) => updateBinding(index, { model })} />
          <SettingsAction label="Saved field binding" actionLabel="Remove" disabled={disabled} onPress={() => onChange({ fieldBindings: (bindings || []).filter((_, position) => position !== index) })} />
        </SettingsCard>;
      })}
      <Feedback theme={props.theme} error={schemaError} />
      </>}
      {!fieldsOpen && validationError && <Feedback theme={props.theme} error={validationError} />}
    </SettingsSection>
  </>;
}
