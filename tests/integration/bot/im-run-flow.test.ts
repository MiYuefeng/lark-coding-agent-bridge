import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCapability, codexCapability } from '../../../src/agent/capability';
import type { AppPreferences } from '../../../src/config/schema';
import type { AgentKind } from '../../../src/config/profile-schema';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { startRunFlow } from '../../../src/bot/run-flow';
import { ProcessPool } from '../../../src/bot/process-pool';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('IM run flow', () => {
  it('rejects missing cwd without falling back to the user home', async () => {
    const h = await createHarness();

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: {
        code: 'empty-requested-cwd',
      },
    });
    expect(h.agent.runOptions).toEqual([]);
  });

  it('submits cwd through RunExecutor and resumes matching sessions', async () => {
    const h = await createHarness();
    const workspaceRealpath = await realpath(h.tmp.workspace);
    h.workspaces.setCwd('chat-1', h.tmp.workspace);
    h.sessions.set('chat-1', 'sess-1', workspaceRealpath);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    expect(result.resumeFrom).toBe('sess-1');
    expect(h.agent.runOptions[0]).toMatchObject({
      runId: 'run-1',
      cwd: workspaceRealpath,
      sessionId: 'sess-1',
    });
  });

  it('uses the profile default workspace when a scope has no explicit binding', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const workspaceRealpath = await realpath(h.tmp.workspace);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: claudeCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    expect(h.agent.runOptions[0]?.cwd).toBe(workspaceRealpath);
  });

  it('lets the current session override the profile Codex defaults', async () => {
    const h = await createHarness({
      defaultWorkspace: true,
      agentKind: 'codex',
      preferences: { model: 'gpt-5.6-luna', reasoningEffort: 'low' },
    });
    h.sessions.setAgentPreferences('chat-1', {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: codexCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });
  });

  it('submits concurrent scopes with their own Codex model settings', async () => {
    const h = await createHarness({
      defaultWorkspace: true,
      agentKind: 'codex',
      maxParallel: 2,
      preferences: { model: 'gpt-5.6-luna', reasoningEffort: 'low' },
    });
    h.sessions.setAgentPreferences('chat-sol', {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });
    h.sessions.setAgentPreferences('chat-terra', {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
    });

    const start = (scopeId: string) => startRunFlow({
      scopeId,
      scope: { source: 'im' as const, chatId: scopeId, actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true as const, reason: 'allowed-user' },
      capability: codexCapability(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });
    const [sol, terra] = await Promise.all([start('chat-sol'), start('chat-terra')]);

    expect(sol.ok).toBe(true);
    expect(terra.ok).toBe(true);
    expect(h.agent.runOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'gpt-5.6-sol', reasoningEffort: 'ultra' }),
      expect.objectContaining({ model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' }),
    ]));
  });

});

async function createHarness(options: {
  defaultWorkspace?: boolean;
  agentKind?: AgentKind;
  maxParallel?: number;
  preferences?: AppPreferences;
} = {}): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('bridge-im-run-flow-');
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  let runCount = 0;
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => options.maxParallel ?? 1),
    activeRuns: new ActiveRuns(),
    createRunId: () => `run-${++runCount}`,
    now: () => 1000,
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: options.agentKind ?? 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    preferences: options.preferences,
    ...(options.agentKind === 'codex' ? { codex: { binaryPath: 'codex' } } : {}),
  });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor,
    sessions,
    workspaces,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        ...(options.defaultWorkspace ? { default: tmp.workspace } : {}),
      },
    },
  };
}
