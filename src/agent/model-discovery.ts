import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProfileConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';
import {
  DEFAULT_REASONING_EFFORT,
  registerDiscoveredModels,
  type ModelOption,
  type ReasoningEffortOption,
} from './models';

const DISCOVERY_TIMEOUT_MS = 5_000;
const DISCOVERY_TTL_MS = 5 * 60_000;
const MAX_MODELS = 100;
const pendingRefreshes = new Map<string, Promise<void>>();
const refreshedAt = new Map<string, number>();

export interface RefreshModelCatalogOptions {
  force?: boolean;
  now?: number;
}

/**
 * Best-effort refresh of the installed agent's model picker. Discovery never
 * blocks bridge startup on failure: the static catalog in models.ts remains
 * available, and a later /config request can retry.
 */
export async function refreshModelCatalogForProfile(
  profileConfig: ProfileConfig,
  profileDir: string,
  opts: RefreshModelCatalogOptions = {},
): Promise<void> {
  const key = discoveryKey(profileConfig, profileDir);
  const now = opts.now ?? Date.now();
  if (!opts.force && now - (refreshedAt.get(key) ?? 0) < DISCOVERY_TTL_MS) return;
  const active = pendingRefreshes.get(key);
  if (active) return active;

  const refresh = (async () => {
    try {
      const models = profileConfig.agentKind === 'codex'
        ? await discoverCodexModels({
            binary: profileConfig.codex?.binaryPath ?? process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex',
            codexHome: effectiveCodexHome(profileConfig, profileDir),
          })
        : await discoverClaudeModels({
            binary: process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude',
          });
      if (models.length > 0) {
        registerDiscoveredModels(profileConfig.agentKind, key, models);
        refreshedAt.set(key, now);
        log.info('agent', 'model-catalog-refreshed', {
          agentKind: profileConfig.agentKind,
          models: models.length,
        });
      }
    } catch (err) {
      log.warn('agent', 'model-catalog-discovery-failed', {
        agentKind: profileConfig.agentKind,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      pendingRefreshes.delete(key);
    }
  })();
  pendingRefreshes.set(key, refresh);
  return refresh;
}

export interface DiscoverCodexModelsOptions {
  binary: string;
  codexHome: string;
  timeoutMs?: number;
}

/** Query the same app-server model/list endpoint used by Codex clients. */
export async function discoverCodexModels(
  opts: DiscoverCodexModelsOptions,
): Promise<ModelOption[]> {
  try {
    const result = await queryCodexAppServer(opts);
    const models = parseCodexModelList(result);
    if (models.length > 0) return models;
  } catch {
    // Older CLIs may not have app-server/model-list. Fall back to the local
    // catalog cache below, which also keeps discovery working offline.
  }
  return readCodexCache(opts.codexHome);
}

export interface DiscoverClaudeModelsOptions {
  binary: string;
  timeoutMs?: number;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Claude Code has no documented list-models command. Its rolling aliases are
 * extracted from the installed CLI's --help output, then augmented with the
 * account-specific model options Claude Code caches locally.
 */
export async function discoverClaudeModels(
  opts: DiscoverClaudeModelsOptions,
): Promise<ModelOption[]> {
  const env = opts.env ?? process.env;
  const configDir = opts.configDir ?? env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const statePaths = env.CLAUDE_CONFIG_DIR
    ? [join(configDir, '.claude.json'), `${configDir}.json`]
    : [join(homedir(), '.claude.json')];
  const [help, settings, ...states] = await Promise.all([
    runForOutput(opts.binary, ['--help'], env, opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS).catch(() => ''),
    readJson(join(configDir, 'settings.json')),
    ...statePaths.map(readJson),
  ]);
  return parseClaudeModelSources({ help, settings, states, env });
}

export interface ClaudeModelSources {
  help?: string;
  settings?: unknown;
  states?: unknown[];
  env?: NodeJS.ProcessEnv;
}

export function parseClaudeModelSources(sources: ClaudeModelSources): ModelOption[] {
  const options: ModelOption[] = [];
  const add = (value: unknown, label?: unknown): void => {
    if (!isSafeModelValue(value)) return;
    options.push({
      value,
      label: typeof label === 'string' && cleanLabel(label)
        ? cleanLabel(label)
        : formatModelLabel(value),
    });
  };

  const modelHelp = extractClaudeModelHelp(sources.help ?? '');
  for (const match of modelHelp.matchAll(/['"]([a-z][a-z0-9_-]{1,31})['"]/g)) {
    if (match[1]!.startsWith('claude-')) continue;
    add(match[1], `${titleCase(match[1]!)}（最新别名）`);
  }
  for (const match of modelHelp.matchAll(/\bclaude-[a-z0-9][a-z0-9._[\]-]*/gi)) add(match[0]);

  const settings = asRecord(sources.settings);
  add(settings?.model);
  const settingsEnv = asRecord(settings?.env);
  for (const key of claudeModelEnvKeys()) add(settingsEnv?.[key]);

  for (const rawState of sources.states ?? []) {
    const state = asRecord(rawState);
    for (const item of arrayValue(state?.additionalModelOptionsCache)) {
      const option = asRecord(item);
      add(option?.value ?? option?.model ?? option?.id, option?.label ?? option?.displayName);
    }
    const accessCache = state?.modelAccessCache;
    for (const item of arrayValue(accessCache)) {
      addClaudeCacheOption(item, add);
    }
    const accessMap = asRecord(accessCache);
    for (const [model, access] of Object.entries(accessMap ?? {})) {
      if (access === false || access === null) continue;
      const option = asRecord(access);
      add(option?.value ?? option?.model ?? option?.id ?? model, option?.label ?? option?.displayName);
    }
    const orgDefault = state?.orgModelDefaultCache;
    if (typeof orgDefault === 'string') add(orgDefault);
    else {
      const option = asRecord(orgDefault);
      add(option?.value ?? option?.model ?? option?.id, option?.label ?? option?.displayName);
    }
  }

  for (const key of claudeModelEnvKeys()) add(sources.env?.[key]);
  return dedupeModels(options).slice(0, MAX_MODELS);
}

function addClaudeCacheOption(
  item: unknown,
  add: (value: unknown, label?: unknown) => void,
): void {
  if (typeof item === 'string') {
    add(item);
    return;
  }
  const option = asRecord(item);
  add(option?.value ?? option?.model ?? option?.id, option?.label ?? option?.displayName);
}

export function parseCodexModelList(input: unknown): ModelOption[] {
  const root = asRecord(input);
  const data = arrayValue(root?.data ?? asRecord(root?.result)?.data);
  return dedupeModels(data.flatMap((item): ModelOption[] => {
    const model = asRecord(item);
    if (!model || model.hidden === true) return [];
    const value = model.model ?? model.id ?? model.slug;
    if (!isSafeModelValue(value)) return [];
    return [{
      value,
      label: cleanLabel(stringValue(model.displayName ?? model.display_name) ?? '')
        || formatModelLabel(value),
      reasoningEfforts: parseReasoningEfforts(
        model.supportedReasoningEfforts ?? model.supported_reasoning_levels,
      ),
    }];
  })).slice(0, MAX_MODELS);
}

function parseReasoningEfforts(input: unknown): ReasoningEffortOption[] {
  const found: ReasoningEffortOption[] = [{
    value: DEFAULT_REASONING_EFFORT,
    label: '跟随默认（不指定）',
  }];
  for (const item of arrayValue(input)) {
    const record = asRecord(item);
    const value = typeof item === 'string'
      ? item
      : record?.reasoningEffort ?? record?.effort ?? record?.value;
    if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) continue;
    found.push({ value, label: effortLabel(value) });
  }
  return dedupeEfforts(found);
}

async function queryCodexAppServer(opts: DiscoverCodexModelsOptions): Promise<unknown> {
  const env = mergeProcessEnv(process.env, { CODEX_HOME: opts.codexHome });
  const child = spawnProcess(opts.binary, ['app-server'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr?.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let nextId = 2;
    const models: unknown[] = [];
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (err) reject(err);
      else resolve({ data: models });
    };
    child.stdin?.on('error', (err) => finish(err));
    const sendModelList = (cursor?: string): void => {
      child.stdin?.write(`${JSON.stringify({
        id: nextId++,
        method: 'model/list',
        params: { limit: MAX_MODELS, includeHidden: false, ...(cursor ? { cursor } : {}) },
      })}\n`);
    };
    const timer = setTimeout(
      () => finish(new Error('Codex model discovery timed out')),
      opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
    );
    child.once('error', (err) => finish(err));
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`Codex app-server exited before model/list (${code ?? 'signal'})`));
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      let newline = stdout.indexOf('\n');
      while (newline !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        newline = stdout.indexOf('\n');
        if (!line) continue;
        let message: Record<string, unknown> | undefined;
        try {
          message = asRecord(JSON.parse(line));
        } catch {
          continue;
        }
        if (message?.id === 1 && message.result) {
          child.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          sendModelList();
          continue;
        }
        if (typeof message?.id === 'number' && message.id >= 2) {
          const result = asRecord(message.result);
          models.push(...arrayValue(result?.data));
          const cursor = stringValue(result?.nextCursor);
          if (cursor && models.length < MAX_MODELS) sendModelList(cursor);
          else finish();
        }
      }
    });
    child.stdin?.write(`${JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'lark-channel-bridge', version: 'model-discovery' },
        capabilities: {},
      },
    })}\n`);
  });
}

async function readCodexCache(codexHome: string): Promise<ModelOption[]> {
  const cache = await readJson(join(codexHome, 'models_cache.json'));
  const root = asRecord(cache);
  const visible = arrayValue(root?.models).filter((item) => {
    const model = asRecord(item);
    return model?.visibility === undefined || model.visibility === 'list';
  });
  return parseCodexModelList({ data: visible });
}

async function runForOutput(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  const child = spawnProcess(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (err) reject(err);
      else resolve(`${stdout}\n${stderr}`);
    };
    const timer = setTimeout(() => finish(new Error('command timed out')), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (err) => finish(err));
    child.once('exit', (code) => code === 0
      ? finish()
      : finish(new Error(`command exited with code ${code ?? 'signal'}`)));
  });
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function effectiveCodexHome(profile: ProfileConfig, profileDir: string): string {
  if (profile.codex?.codexHome) return profile.codex.codexHome;
  if (profile.codex?.inheritCodexHome !== false) {
    return process.env.CODEX_HOME ?? join(homedir(), '.codex');
  }
  return join(profileDir, 'codex-home');
}

function discoveryKey(profile: ProfileConfig, profileDir: string): string {
  if (profile.agentKind === 'codex') {
    return `codex:${profile.codex?.binaryPath ?? 'codex'}:${effectiveCodexHome(profile, profileDir)}`;
  }
  const binary = process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude';
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return `claude:${binary}:${configDir}`;
}

function extractClaudeModelHelp(help: string): string {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*--model(?:\s|,)/.test(line));
  if (start === -1) return '';
  const selected = [lines[start]!];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s{0,4}-[-a-zA-Z]/.test(lines[i]!)) break;
    selected.push(lines[i]!);
  }
  return selected.join(' ');
}

function claudeModelEnvKeys(): string[] {
  return [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ];
}

function isSafeModelValue(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !value.startsWith('-')
    && !/[\u0000-\u001f\u007f\s]/.test(value);
}

function dedupeModels(options: readonly ModelOption[]): ModelOption[] {
  const found = new Map<string, ModelOption>();
  for (const option of options) if (!found.has(option.value)) found.set(option.value, option);
  return [...found.values()];
}

function dedupeEfforts(options: readonly ReasoningEffortOption[]): ReasoningEffortOption[] {
  const found = new Map<string, ReasoningEffortOption>();
  for (const option of options) if (!found.has(option.value)) found.set(option.value, option);
  return [...found.values()];
}

function formatModelLabel(value: string): string {
  const label = value.startsWith('claude-')
    ? `Claude ${titleCase(value.slice('claude-'.length).replace(/-/g, ' '))}`
    : value;
  return cleanLabel(label);
}

function effortLabel(value: string): string {
  if (value === 'xhigh') return 'XHigh';
  if (value === 'ultra') return 'Ultra（自动任务委派）';
  return titleCase(value);
}

function titleCase(value: string): string {
  return value.replace(/(^|[\s_-])([a-z])/g, (_, prefix: string, letter: string) =>
    `${prefix}${letter.toUpperCase()}`);
}

function cleanLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
