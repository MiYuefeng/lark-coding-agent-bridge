import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  isDefaultModel,
  modelLabel,
  normalizeModelSelection,
  normalizeReasoningEffortSelection,
  reasoningEffortLabel,
  resolveAgentModelConfig,
  resolveModelArg,
  resolveReasoningEffortArg,
  supportedModels,
  supportedReasoningEfforts,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toContain('claude-opus-4-8');
    expect(codex.map((m) => m.value)).toEqual(expect.arrayContaining([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]));
    expect(claude.map((m) => m.value)).not.toContain('gpt-5-codex');
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('claude-opus-4-8')).toBe(false);
  });

  it('coerces unknown / cross-agent selections back to the default option', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    // A Codex model left over after switching a profile to Claude is invalid.
    expect(normalizeModelSelection('claude', 'gpt-5-codex')).toBe(DEFAULT_MODEL);
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
    // Cross-agent value → no flag rather than a broken model.
    expect(resolveModelArg('codex', 'claude-opus-4-8')).toBeUndefined();
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('Opus 4.8（最新）');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随默认');
  });

  it('offers model-specific GPT-5.6 reasoning efforts', () => {
    const sol = supportedReasoningEfforts('codex', 'gpt-5.6-sol').map((item) => item.value);
    const terra = supportedReasoningEfforts('codex', 'gpt-5.6-terra').map((item) => item.value);
    const luna = supportedReasoningEfforts('codex', 'gpt-5.6-luna').map((item) => item.value);

    expect(sol).toEqual([
      DEFAULT_REASONING_EFFORT,
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(terra).toContain('ultra');
    expect(luna).toContain('max');
    expect(luna).not.toContain('ultra');
    expect(supportedReasoningEfforts('claude', 'claude-opus-4-8')).toEqual([]);
  });

  it('normalizes and resolves reasoning effort for the selected model', () => {
    expect(normalizeReasoningEffortSelection('codex', 'gpt-5.6-sol', 'ultra')).toBe('ultra');
    expect(normalizeReasoningEffortSelection('codex', 'gpt-5.6-luna', 'ultra')).toBe(
      DEFAULT_REASONING_EFFORT,
    );
    expect(resolveReasoningEffortArg('codex', 'gpt-5.6-terra', 'xhigh')).toBe('xhigh');
    expect(resolveReasoningEffortArg('codex', 'gpt-5.6-luna', 'ultra')).toBeUndefined();
    expect(resolveReasoningEffortArg('claude', 'claude-opus-4-8', 'high')).toBeUndefined();
    expect(reasoningEffortLabel('codex', 'gpt-5.6-sol', 'ultra')).toContain('Ultra');
  });

  it('resolves per-session choices over profile defaults independently', () => {
    expect(resolveAgentModelConfig(
      'codex',
      { model: 'gpt-5.6-luna', reasoningEffort: 'low' },
      { model: 'gpt-5.6-sol', reasoningEffort: 'ultra' },
    )).toMatchObject({
      modelSelection: 'gpt-5.6-sol',
      reasoningEffortSelection: 'ultra',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });

    expect(resolveAgentModelConfig(
      'codex',
      { model: 'gpt-5.6-terra', reasoningEffort: 'high' },
      { model: DEFAULT_MODEL, reasoningEffort: DEFAULT_REASONING_EFFORT },
    )).toMatchObject({
      modelSelection: DEFAULT_MODEL,
      reasoningEffortSelection: DEFAULT_REASONING_EFFORT,
      model: undefined,
      reasoningEffort: undefined,
    });
  });
});
