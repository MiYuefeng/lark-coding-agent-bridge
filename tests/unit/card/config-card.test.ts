import { describe, expect, it } from 'vitest';
import { configFormCard, type ConfigFormOpts } from '../../../src/card/config-card';

const base: ConfigFormOpts = {
  agentKind: 'claude',
  mode: 'personal',
  model: 'inherit-profile',
  profileModel: 'default',
  messageReply: 'markdown',
  showToolCalls: false,
  cotMessages: 'off',
  maxConcurrentRuns: 1,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: false,
  larkCliIdentity: 'bot-only',
  allowedUsers: [],
  allowedChats: [],
  admins: [],
  knownChats: [],
};

describe('configFormCard console URL', () => {
  it('shows the web console URL when one is running', () => {
    const url = 'http://127.0.0.1:53219/?token=abc123';
    const card = configFormCard({ ...base, consoleUrl: url });
    expect(JSON.stringify(card)).toContain(url);
    expect(JSON.stringify(card)).toContain('Web 控制台');
  });

  it('shows Codex model and reasoning-effort options only for Codex profiles', () => {
    const codex = JSON.stringify(configFormCard({
      ...base,
      agentKind: 'codex',
      model: 'gpt-5.6-sol',
      profileModel: 'default',
      reasoningEffort: 'ultra',
      profileReasoningEffort: 'medium',
    }));
    expect(codex).toContain('gpt-5.6-sol');
    expect(codex).toContain('reasoning_effort');
    expect(codex).toContain('ultra');

    const luna = JSON.stringify(configFormCard({
      ...base,
      agentKind: 'codex',
      model: 'gpt-5.6-luna',
      profileModel: 'gpt-5.6-terra',
      reasoningEffort: 'max',
      profileReasoningEffort: 'high',
    }));
    expect(luna).toContain('ultra');

    const claude = JSON.stringify(configFormCard(base));
    expect(claude).not.toContain('reasoning_effort');
  });

  it('offers a distinct profile-inheritance choice for the current session', () => {
    const card = JSON.stringify(configFormCard({
      ...base,
      agentKind: 'codex',
      profileModel: 'gpt-5.6-terra',
      profileReasoningEffort: 'high',
      reasoningEffort: 'inherit-profile',
    }));
    expect(card).toContain('inherit-profile');
    expect(card).toContain('跟随 Profile 默认');
    expect(card).toContain('CLI/账号默认（本会话不指定）');
    expect(card).toContain('Codex 默认（本会话不覆盖）');
  });

  it('omits the console section when no console is running', () => {
    const card = configFormCard(base);
    expect(JSON.stringify(card)).not.toContain('Web 控制台');
  });
});
