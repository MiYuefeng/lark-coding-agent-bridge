import type { AgentKind } from '../config/profile-schema';

/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';
export const DEFAULT_REASONING_EFFORT = 'default';
/** Config-card sentinel meaning the current session follows profile defaults. */
export const INHERIT_PROFILE_SELECTION = 'inherit-profile';

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface ReasoningEffortOption {
  /** Stored in preferences; the default sentinel omits the Codex override. */
  value: typeof DEFAULT_REASONING_EFFORT | CodexReasoningEffort;
  /** Human-facing label shown in config pickers. */
  label: string;
}

export interface AgentModelPreferences {
  model?: string;
  reasoningEffort?: string;
}

export interface ResolvedAgentModelConfig {
  modelSelection: string;
  reasoningEffortSelection: ReasoningEffortOption['value'];
  model: string | undefined;
  reasoningEffort: CodexReasoningEffort | undefined;
}

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
  /** Codex reasoning levels supported by this model. Absent for Claude. */
  reasoningEfforts?: ReasoningEffortOption[];
}

const DEFAULT_EFFORT_OPTION: ReasoningEffortOption = {
  value: DEFAULT_REASONING_EFFORT,
  label: '跟随默认（不指定）',
};

const CODEX_EFFORT_OPTIONS: Record<CodexReasoningEffort, ReasoningEffortOption> = {
  low: { value: 'low', label: 'Low' },
  medium: { value: 'medium', label: 'Medium' },
  high: { value: 'high', label: 'High' },
  xhigh: { value: 'xhigh', label: 'XHigh' },
  max: { value: 'max', label: 'Max' },
  ultra: { value: 'ultra', label: 'Ultra（自动任务委派）' },
};

function effortOptions(...levels: CodexReasoningEffort[]): ReasoningEffortOption[] {
  return [DEFAULT_EFFORT_OPTION, ...levels.map((level) => CODEX_EFFORT_OPTIONS[level])];
}

const GPT_5_6_EFFORTS = effortOptions('low', 'medium', 'high', 'xhigh', 'max', 'ultra');
const GPT_5_6_LUNA_EFFORTS = effortOptions('low', 'medium', 'high', 'xhigh', 'max');
const LEGACY_CODEX_EFFORTS = effortOptions('low', 'medium', 'high');

/**
 * Claude Code models. Pinned to concrete version ids (Claude Code's `--model`
 * accepts the full model-id string, not just the `opus`/`sonnet` aliases) so
 * the picker names an exact model. Add new ids here when a generation ships;
 * `opusplan` is kept as the one alias with no versioned equivalent (it runs
 * Opus for planning and Sonnet for execution).
 */
const CLAUDE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8（最新）' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
  { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
];

/** Codex CLI models. Forwarded to `codex exec --model`. */
const CODEX_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）', reasoningEfforts: GPT_5_6_EFFORTS },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol（旗舰）', reasoningEfforts: GPT_5_6_EFFORTS },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra（均衡）', reasoningEfforts: GPT_5_6_EFFORTS },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna（高效）', reasoningEfforts: GPT_5_6_LUNA_EFFORTS },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex（旧版）', reasoningEfforts: LEGACY_CODEX_EFFORTS },
  { value: 'gpt-5', label: 'GPT-5（旧版）', reasoningEfforts: LEGACY_CODEX_EFFORTS },
  { value: 'o3', label: 'o3（旧版）', reasoningEfforts: LEGACY_CODEX_EFFORTS },
];

/** The model picker options for a profile's agent kind. */
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  return agentKind === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * Coerce a stored model preference into a value guaranteed to be one of the
 * current agent's picker options — Feishu's `select_static` requires
 * `initial_option` to match an option value exactly. Unknown / cross-agent
 * values (e.g. a Claude alias left over after switching a profile to Codex)
 * fall back to {@link DEFAULT_MODEL}.
 */
export function normalizeModelSelection(
  agentKind: AgentKind,
  value: string | undefined,
): string {
  if (isDefaultModel(value)) return DEFAULT_MODEL;
  return supportedModels(agentKind).some((m) => m.value === value)
    ? (value as string)
    : DEFAULT_MODEL;
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` to omit
 * the `--model` flag. Cross-agent / unknown values are treated as "default".
 */
export function resolveModelArg(
  agentKind: AgentKind,
  value: string | undefined,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: AgentKind, value: string | undefined): string {
  const normalized = normalizeModelSelection(agentKind, value);
  return supportedModels(agentKind).find((m) => m.value === normalized)?.label ?? normalized;
}

/** Reasoning-effort options supported by the selected Codex model. */
export function supportedReasoningEfforts(
  agentKind: AgentKind,
  model: string | undefined,
): ReasoningEffortOption[] {
  if (agentKind !== 'codex') return [];
  const normalizedModel = normalizeModelSelection(agentKind, model);
  return CODEX_MODELS.find((item) => item.value === normalizedModel)?.reasoningEfforts
    ?? [DEFAULT_EFFORT_OPTION];
}

/** Coerce a stored or submitted effort to a valid option for the selected model. */
export function normalizeReasoningEffortSelection(
  agentKind: AgentKind,
  model: string | undefined,
  value: string | undefined,
): ReasoningEffortOption['value'] {
  if (!value || value === DEFAULT_REASONING_EFFORT) return DEFAULT_REASONING_EFFORT;
  return supportedReasoningEfforts(agentKind, model).some((option) => option.value === value)
    ? (value as CodexReasoningEffort)
    : DEFAULT_REASONING_EFFORT;
}

/** Resolve the Codex config override, or undefined for Claude/default. */
export function resolveReasoningEffortArg(
  agentKind: AgentKind,
  model: string | undefined,
  value: string | undefined,
): CodexReasoningEffort | undefined {
  const normalized = normalizeReasoningEffortSelection(agentKind, model, value);
  return normalized === DEFAULT_REASONING_EFFORT ? undefined : normalized;
}

/** Picker label for a reasoning-effort value. */
export function reasoningEffortLabel(
  agentKind: AgentKind,
  model: string | undefined,
  value: string | undefined,
): string {
  const normalized = normalizeReasoningEffortSelection(agentKind, model, value);
  return supportedReasoningEfforts(agentKind, model).find((item) => item.value === normalized)?.label
    ?? normalized;
}

/**
 * Resolve one run's effective model configuration. Session fields override
 * profile fields independently; an absent session field inherits its profile
 * counterpart, while the explicit `default` sentinel suppresses the CLI flag.
 */
export function resolveAgentModelConfig(
  agentKind: AgentKind,
  profile: AgentModelPreferences,
  session: AgentModelPreferences = {},
): ResolvedAgentModelConfig {
  const modelPreference = session.model === undefined ? profile.model : session.model;
  const modelSelection = normalizeModelSelection(agentKind, modelPreference);
  const reasoningPreference = session.reasoningEffort === undefined
    ? profile.reasoningEffort
    : session.reasoningEffort;
  const reasoningEffortSelection = normalizeReasoningEffortSelection(
    agentKind,
    modelSelection,
    reasoningPreference,
  );
  return {
    modelSelection,
    reasoningEffortSelection,
    model: resolveModelArg(agentKind, modelSelection),
    reasoningEffort: resolveReasoningEffortArg(
      agentKind,
      modelSelection,
      reasoningEffortSelection,
    ),
  };
}
