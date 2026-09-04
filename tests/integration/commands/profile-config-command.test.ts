import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret, listSecretIds } from '../../../src/config/keystore';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { getMessageReplyMode, getRequireMentionInGroup, secretKeyForApp } from '../../../src/config/schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: vi.fn(async () => ({
    ok: true,
    botName: 'Updated Bot',
    botOpenId: 'ou-bot',
  })),
}));

const identityPolicyMocks = vi.hoisted(() => ({
  applyLarkCliIdentityPolicy: vi.fn(async () => true),
}));

vi.mock('../../../src/lark-cli/identity-policy', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lark-cli/identity-policy')>(
    '../../../src/lark-cli/identity-policy',
  );
  return {
    ...actual,
    applyLarkCliIdentityPolicy: identityPolicyMocks.applyLarkCliIdentityPolicy,
  };
});

const roots: string[] = [];

beforeEach(() => {
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockReset();
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValue(true);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile-aware account and config commands', () => {
  it('saves /config submit into the active v2 profile without flattening root config', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.messageReply === 'text',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.activeProfile).toBe('claude');
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.preferences).toMatchObject({
      messageReply: 'text',
      messageReplyMigrated: true,
      showToolCalls: false,
      maxConcurrentRuns: 7,
      runIdleTimeoutMinutes: 15,
    });
    expect(root.profiles.claude?.access.requireMentionInGroup).toBe(false);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('user-default');
    expect(root.profiles.claude?.larkCli.localUserImport).toMatchObject({
      status: 'not-needed',
      reason: 'manual-user-default',
    });
    expect(getRequireMentionInGroup(runtimeProfileConfig(root, 'claude'))).toBe(false);
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
  });

  it('stores model choices on the current session without changing the profile default', async () => {
    vi.useFakeTimers();
    const h = await createHarness({ preferences: { model: 'claude-sonnet-5' } });

    await h.command('/config submit', {
      model: 'claude-opus-4-8',
      message_reply: 'text',
    });
    await vi.waitFor(() => {
      expect(h.sessions.getAgentPreferences('chat-1')).toEqual({ model: 'claude-opus-4-8' });
    });
    expect((await readRoot(h.rootDir)).profiles.claude?.preferences.model).toBe('claude-sonnet-5');

    await h.command('/config submit', {
      model: 'default',
      message_reply: 'text',
    });
    await vi.waitFor(() => {
      expect(h.sessions.getAgentPreferences('chat-1')).toEqual({ model: 'default' });
    });

    await h.command('/config submit', {
      model: 'inherit-profile',
      message_reply: 'text',
    });
    await vi.waitFor(() => {
      expect(h.sessions.getAgentPreferences('chat-1')).toEqual({});
    });
  });

  it('keeps Codex model and reasoning choices isolated between session scopes', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      agentKind: 'codex',
      preferences: { model: 'gpt-5.6-luna', reasoningEffort: 'low' },
    });

    await h.command('/config submit', {
      model: 'gpt-5.6-sol',
      reasoning_effort: 'ultra',
      message_reply: 'text',
    }, 'chat-sol');
    await h.command('/config submit', {
      model: 'gpt-5.6-terra',
      reasoning_effort: 'high',
      message_reply: 'text',
    }, 'chat-terra');

    await vi.waitFor(() => {
      expect(h.sessions.getAgentPreferences('chat-sol')).toEqual({
        model: 'gpt-5.6-sol',
        reasoningEffort: 'ultra',
      });
      expect(h.sessions.getAgentPreferences('chat-terra')).toEqual({
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
      });
    });
    expect((await readRoot(h.rootDir)).profiles['codex-dev']?.preferences).toMatchObject({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
    });
  });

  it('persists a model-compatible Codex reasoning effort for the current session', async () => {
    vi.useFakeTimers();
    const h = await createHarness({ agentKind: 'codex' });

    await h.command('/config submit', {
      model: 'gpt-5.6-terra',
      reasoning_effort: 'ultra',
      message_reply: 'text',
    });
    await vi.waitFor(() => {
      expect(h.sessions.getAgentPreferences('chat-1')).toEqual({
        model: 'gpt-5.6-terra',
        reasoningEffort: 'ultra',
      });
    });
  });

  it('drops Ultra when switching the same Codex profile to Luna', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      agentKind: 'codex',
      preferences: { model: 'gpt-5.6-sol', reasoningEffort: 'ultra' },
    });

    await h.command('/config submit', {
      model: 'gpt-5.6-luna',
      reasoning_effort: 'ultra',
      message_reply: 'text',
    });
    await vi.waitFor(() => {
      expect(h.sessions.getAgentPreferences('chat-1')).toEqual({ model: 'gpt-5.6-luna' });
    });
    expect((await readRoot(h.rootDir)).profiles['codex-dev']?.preferences).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });
  });

  it('keeps the current message reply mode when the config submit payload omits it', async () => {
    vi.useFakeTimers();
    const h = await createHarness({
      preferences: {
        messageReply: 'text',
        messageReplyMigrated: true,
      },
    });

    await h.command('/config submit', {
      show_tool_calls: 'show',
      max_concurrent_runs: '8',
      run_idle_timeout_minutes: '20',
      require_mention_in_group: 'yes',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.maxConcurrentRuns === 8,
    );
    expect(root.profiles.claude?.preferences.messageReply).toBe('text');
    expect(root.profiles.claude?.preferences.messageReplyMigrated).toBe(true);
    expect(getMessageReplyMode(runtimeProfileConfig(root, 'claude'))).toBe('text');
  });

  it('does not save a lark-cli identity change when applying the runtime policy fails', async () => {
    vi.useFakeTimers();
    identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValueOnce(false);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('bot-only');
    expect(root.profiles.claude?.preferences.messageReply).not.toBe('text');
    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('lark-cli 身份策略');
    expect(card).not.toContain('偏好已保存');
  });

  it('rolls back lark-cli identity when saving config fails after applying the runtime policy', async () => {
    vi.useFakeTimers();
    const applied = deferred<boolean>();
    identityPolicyMocks.applyLarkCliIdentityPolicy
      .mockImplementationOnce(async () => applied.promise)
      .mockResolvedValue(true);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await writeFile(resolveAppPaths({ rootDir: h.rootDir }).configFile, '{invalid json', 'utf8');
    applied.resolve(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('已回滚');
    expect(card).not.toContain('未做任何修改');
    expect(card).not.toContain('偏好已保存');
  });

  it('saves /account submit into the active v2 profile and profile-local keystore', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/account submit', {
      app_id: 'cli_new',
      app_secret: 'new-secret',
      tenant: 'lark',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.accounts.app.id === 'cli_new',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.accounts.app).toMatchObject({
      id: 'cli_new',
      tenant: 'lark',
      secret: {
        source: 'exec',
        provider: 'bridge',
        id: secretKeyForApp('cli_new'),
      },
    });
    expect(root.secrets?.providers?.bridge?.command).toContain('secrets-getter');
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
    await expect(
      getSecret(secretKeyForApp('cli_new'), resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' })),
    ).resolves.toBe('new-secret');
    const claudePaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' });
    const codexPaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'codex-dev' });
    expect(claudePaths.secretsFile).not.toBe(codexPaths.secretsFile);
    await expect(
      listSecretIds(codexPaths),
    ).resolves.not.toContain(secretKeyForApp('cli_new'));
  });
});

async function createHarness(options: {
  agentKind?: AgentKind;
  preferences?: RootConfig['profiles'][string]['preferences'];
} = {}): Promise<{
  rootDir: string;
  channel: ReturnType<typeof createFakeChannel>;
  sessions: SessionStore;
  command(content: string, formValue?: Record<string, unknown>, scope?: string): Promise<boolean>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-profile-config-command-'));
  roots.push(rootDir);
  const workspace = join(rootDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const profile = options.agentKind === 'codex' ? 'codex-dev' : 'claude';
  const root = await writeRoot(rootDir, workspace, options.preferences, profile);
  const profileConfig = root.profiles[profile]!;
  const appPaths = resolveAppPaths({ rootDir, profile });
  const channel = createFakeChannel();
  const sessions = new SessionStore(appPaths.sessionsFile);
  const workspaces = new WorkspaceStore(appPaths.workspacesFile);
  const controls = {
    profile,
    profileConfig,
    botOwnerId: 'ou-admin',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: appPaths.configFile,
    cfg: runtimeProfileConfig(root, profile),
    processId: 'proc-1',
  } satisfies Controls;

  return {
    rootDir,
    channel,
    sessions,
    command: (content: string, formValue?: Record<string, unknown>, scope = 'chat-1') =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content, scope),
        scope,
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent: new FakeAgentAdapter(),
        activeRuns: new ActiveRuns(),
        controls,
        formValue,
        fromCardAction: true,
      }),
  };
}

async function writeRoot(
  rootDir: string,
  workspace: string,
  preferences: RootConfig['profiles'][string]['preferences'] = {},
  activeProfile = 'claude',
): Promise<RootConfig> {
  const root: RootConfig = {
    schemaVersion: 2,
    activeProfile,
    preferences: {},
    profiles: {
      claude: createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: {
          app: { id: 'cli_old', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        access: { admins: ['ou-admin'] },
      }),
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: {
          app: { id: 'cli_codex', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        codex: { binaryPath: 'codex' },
      }),
    },
  };
  root.profiles[activeProfile]!.workspaces.default = workspace;
  root.profiles[activeProfile]!.preferences = {
    ...root.profiles[activeProfile]!.preferences,
    ...preferences,
  };
  await writeJson(resolveAppPaths({ rootDir }).configFile, root);
  await writeFile(join(rootDir, 'active-profile'), `${activeProfile}\n`, 'utf8');
  return root;
}

async function readRoot(rootDir: string): Promise<RootConfig> {
  return JSON.parse(await readFile(resolveAppPaths({ rootDir }).configFile, 'utf8')) as RootConfig;
}

async function waitForRoot(
  rootDir: string,
  predicate: (root: RootConfig) => boolean,
): Promise<RootConfig> {
  let lastRoot = await readRoot(rootDir);
  await vi.waitFor(async () => {
    lastRoot = await readRoot(rootDir);
    expect(predicate(lastRoot)).toBe(true);
  }, { timeout: 5000 });
  return lastRoot;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function appliedLarkCliIdentities(): unknown[] {
  return (
    identityPolicyMocks.applyLarkCliIdentityPolicy.mock.calls as unknown as Array<[unknown, unknown]>
  ).map((call) => call[1]);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function message(content: string, chatId = 'chat-1'): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId,
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
