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

/**
 * Codex publishes effort values in its runtime model catalog. Keep this open
 * ended so a newer CLI can advertise a new level without requiring a bridge
 * release just to forward the string back to that CLI.
 */
export type CodexReasoningEffort = string;

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

const CODEX_EFFORT_OPTIONS: Record<string, ReasoningEffortOption> = {
  low: { value: 'low', label: 'Low' },
  medium: { value: 'medium', label: 'Medium' },
  high: { value: 'high', label: 'High' },
  xhigh: { value: 'xhigh', label: 'XHigh' },
  max: { value: 'max', label: 'Max' },
  ultra: { value: 'ultra', label: 'Ultra（自动任务委派）' },
};

function effortOptions(...levels: CodexReasoningEffort[]): ReasoningEffortOption[] {
  return [DEFAULT_EFFORT_OPTION, ...levels.map((level) => reasoningEffortOption(level))];
}

function reasoningEffortOption(level: string): ReasoningEffortOption {
  return CODEX_EFFORT_OPTIONS[level] ?? {
    value: level,
    label: level.replace(/(^|[-_])([a-z])/g, (_, prefix: string, letter: string) =>
      `${prefix}${letter.toUpperCase()}`),
  };
}

const GPT_5_6_EFFORTS = effortOptions('low', 'medium', 'high', 'xhigh', 'max', 'ultra');
const GPT_5_6_LUNA_EFFORTS = effortOptions('low', 'medium', 'high', 'xhigh', 'max');
const LEGACY_CODEX_EFFORTS = effortOptions('low', 'medium', 'high');

/** Claude Code offline fallback; runtime discovery is merged ahead of it. */
const CLAUDE_FALLBACK_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'sonnet', label: 'Sonnet（最新别名）' },
  { value: 'opus', label: 'Opus（最新别名）' },
  { value: 'haiku', label: 'Haiku（最新别名）' },
  { value: 'fable', label: 'Fable（最新别名）' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8（最新）' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
  { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
];

/** Codex CLI models. Forwarded to `codex exec --model`. */
const CODEX_FALLBACK_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）', reasoningEfforts: GPT_5_6_EFFORTS },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol（旗舰）', reasoningEfforts: GPT_5_6_EFFORTS },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra（均衡）', reasoningEfforts: GPT_5_6_EFFORTS },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna（高效）', reasoningEfforts: GPT_5_6_LUNA_EFFORTS },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex（旧版）', reasoningEfforts: LEGACY_CODEX_EFFORTS },
  { value: 'gpt-5', label: 'GPT-5（旧版）', reasoningEfforts: LEGACY_CODEX_EFFORTS },
  { value: 'o3', label: 'o3（旧版）', reasoningEfforts: LEGACY_CODEX_EFFORTS },
];

const discoveredCatalogs: Record<AgentKind, Map<string, readonly ModelOption[]>> = {
  claude: new Map(),
  codex: new Map(),
};

/**
 * Install one discovery source's latest snapshot. Sources are kept separate
 * so multiple profiles with different Codex homes can coexist in one
 * supervisor process. Passing an empty list intentionally leaves the last
 * successful snapshot intact; transient CLI failures must not erase a picker.
 */
export function registerDiscoveredModels(
  agentKind: AgentKind,
  source: string,
  models: readonly ModelOption[],
): void {
  if (models.length === 0) return;
  discoveredCatalogs[agentKind].set(source, models.map(cloneModelOption));
}

/** Test helper; production callers should update a named source instead. */
export function clearDiscoveredModels(): void {
  discoveredCatalogs.claude.clear();
  discoveredCatalogs.codex.clear();
}

/** The model picker options for a profile's agent kind. */
export function supportedModels(agentKind: AgentKind): ModelOption[] {
  const fallback = agentKind === 'codex' ? CODEX_FALLBACK_MODELS : CLAUDE_FALLBACK_MODELS;
  const discovered = [...discoveredCatalogs[agentKind].values()].flat();
  const merged = mergeModelOptions([...discovered, ...fallback].filter((m) => m.value !== DEFAULT_MODEL));
  const defaultFallback = fallback.find((m) => m.value === DEFAULT_MODEL)!;
  const defaultOption = agentKind === 'codex'
    ? {
        ...defaultFallback,
        reasoningEfforts: mergeReasoningEfforts([
          ...(discovered.flatMap((model) => model.reasoningEfforts ?? [])),
          ...(defaultFallback.reasoningEfforts ?? []),
        ]),
      }
    : defaultFallback;
  // Feishu static selects accept at most 100 options. Reserve one slot for
  // the required default sentinel and keep runtime-discovered models first.
  return [cloneModelOption(defaultOption), ...merged.slice(0, 99)];
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
  return supportedModels(agentKind).find((item) => item.value === normalizedModel)?.reasoningEfforts
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

function mergeModelOptions(options: readonly ModelOption[]): ModelOption[] {
  const byValue = new Map<string, ModelOption>();
  for (const option of options) {
    const current = byValue.get(option.value);
    if (!current) {
      byValue.set(option.value, cloneModelOption(option));
      continue;
    }
    if (option.reasoningEfforts?.length) {
      current.reasoningEfforts = mergeReasoningEfforts([
        ...(current.reasoningEfforts ?? []),
        ...option.reasoningEfforts,
      ]);
    }
  }
  return [...byValue.values()];
}

function mergeReasoningEfforts(options: readonly ReasoningEffortOption[]): ReasoningEffortOption[] {
  const order = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const byValue = new Map<string, ReasoningEffortOption>();
  for (const option of options) {
    if (!byValue.has(option.value)) byValue.set(option.value, { ...option });
  }
  return [...byValue.values()].sort((a, b) => {
    const ai = order.indexOf(a.value);
    const bi = order.indexOf(b.value);
    if (ai === -1 && bi === -1) return a.value.localeCompare(b.value);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function cloneModelOption(option: ModelOption): ModelOption {
  return {
    ...option,
    ...(option.reasoningEfforts
      ? { reasoningEfforts: option.reasoningEfforts.map((effort) => ({ ...effort })) }
      : {}),
  };
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
