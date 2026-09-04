import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../../src/session/store.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('session-scoped agent preferences', () => {
  it('persists independent model choices and clears only the reset scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-store-test-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'sessions.json');
    const store = new SessionStore(file);

    store.setIdleTimeoutMinutes('chat-sol', 15);
    store.setAgentPreferences('chat-sol', {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });
    store.setAgentPreferences('chat-luna', {
      model: 'gpt-5.6-luna',
      reasoningEffort: 'max',
    });
    store.setAgentPreferences('chat-cli-default', {
      model: 'default',
      reasoningEffort: 'default',
    });
    await store.flush();

    const reloaded = new SessionStore(file);
    await reloaded.load();
    expect(reloaded.getAgentPreferences('chat-sol')).toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });
    expect(reloaded.getAgentPreferences('chat-luna')).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'max',
    });
    expect(reloaded.getAgentPreferences('chat-cli-default')).toEqual({
      model: 'default',
      reasoningEffort: 'default',
    });

    reloaded.clear('chat-sol');
    expect(reloaded.getAgentPreferences('chat-sol')).toEqual({});
    expect(reloaded.getIdleTimeoutMinutes('chat-sol')).toBe(15);
    expect(reloaded.getAgentPreferences('chat-luna')).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'max',
    });
    await reloaded.flush();
  });
});
