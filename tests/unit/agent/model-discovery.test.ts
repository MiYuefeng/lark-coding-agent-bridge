import { afterEach, describe, expect, it } from 'vitest';
import {
  parseClaudeModelSources,
  parseCodexModelList,
} from '../../../src/agent/model-discovery.js';
import {
  clearDiscoveredModels,
  registerDiscoveredModels,
  supportedModels,
  supportedReasoningEfforts,
} from '../../../src/agent/models.js';

afterEach(() => clearDiscoveredModels());

describe('dynamic agent model discovery', () => {
  it('maps the Codex app-server catalog and keeps future effort values', () => {
    const models = parseCodexModelList({
      data: [
        {
          id: 'gpt-6-astra',
          model: 'gpt-6-astra',
          displayName: 'GPT-6-Astra',
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fast' },
            { reasoningEffort: 'ultracode', description: 'Future level' },
          ],
        },
        {
          id: 'hidden-model',
          model: 'hidden-model',
          displayName: 'Hidden',
          hidden: true,
          supportedReasoningEfforts: [],
        },
      ],
    });

    expect(models).toEqual([
      expect.objectContaining({
        value: 'gpt-6-astra',
        label: 'GPT-6-Astra',
        reasoningEfforts: expect.arrayContaining([
          expect.objectContaining({ value: 'low' }),
          expect.objectContaining({ value: 'ultracode' }),
        ]),
      }),
    ]);

    registerDiscoveredModels('codex', 'test-codex-home', models);
    expect(supportedModels('codex').map((model) => model.value)[1]).toBe('gpt-6-astra');
    expect(supportedReasoningEfforts('codex', 'gpt-6-astra').map((effort) => effort.value))
      .toContain('ultracode');
  });

  it('discovers Claude rolling aliases, cached account models, and configured models', () => {
    const models = parseClaudeModelSources({
      help: [
        '  --model <model>  Model for this session. Provide an alias for the latest model',
        "                   (e.g. 'mythos', 'opus', or 'sonnet') or a model's full name",
        "                   (e.g. 'claude-mythos-6').",
        '  --name <name>     Session name',
      ].join('\n'),
      settings: {
        model: 'claude-team-router-v2',
        env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5' },
      },
      states: [{
        additionalModelOptionsCache: [
          { value: 'claude-fable-5[1m]', label: 'Fable' },
          { value: '--unsafe-option', label: 'Unsafe' },
        ],
      }],
      env: { ANTHROPIC_MODEL: 'company/claude-production' },
    });

    expect(models.map((model) => model.value)).toEqual(expect.arrayContaining([
      'mythos',
      'opus',
      'sonnet',
      'claude-mythos-6',
      'claude-team-router-v2',
      'claude-haiku-5',
      'claude-fable-5[1m]',
      'company/claude-production',
    ]));
    expect(models.map((model) => model.value)).not.toContain('--unsafe-option');
    expect(models.find((model) => model.value === 'claude-mythos-6')?.label)
      .toBe('Claude Mythos 6');
  });

  it('does not treat unrelated quoted help values as Claude model aliases', () => {
    const models = parseClaudeModelSources({
      help: "--output-format <format> choices: 'text', 'json'",
    });
    expect(models).toEqual([]);
  });

  it('merges independent profile catalogs instead of replacing another profile', () => {
    registerDiscoveredModels('codex', 'profile-a', [
      { value: 'model-a', label: 'Model A', reasoningEfforts: [] },
    ]);
    registerDiscoveredModels('codex', 'profile-b', [
      { value: 'model-b', label: 'Model B', reasoningEfforts: [] },
    ]);

    expect(supportedModels('codex').map((model) => model.value)).toEqual(expect.arrayContaining([
      'model-a',
      'model-b',
    ]));
  });
});
