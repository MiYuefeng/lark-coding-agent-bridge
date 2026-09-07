import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { log } from '../../core/logger';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import type {
  AgentEvent,
  AgentRun,
  AgentRunOptions,
  AgentSteerInput,
  AgentSteerResult,
} from '../types';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CreateCodexAppServerRunOptions {
  binary: string;
  env: NodeJS.ProcessEnv;
  run: AgentRunOptions & { cwd: string };
  initialPrompt: string;
  stopGraceMs: number;
}

interface RpcPending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const RPC_TIMEOUT_MS = 15_000;

/**
 * One app-server process per bridge run. Keeping the process scoped to the run
 * preserves the adapter's existing isolation/stop semantics while exposing
 * Codex's native `turn/steer` protocol on the live turn.
 */
export function createCodexAppServerRun(options: CreateCodexAppServerRunOptions): AgentRun {
  const child = spawnProcess(
    options.binary,
    buildCodexAppServerArgs(),
    {
      cwd: options.run.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as CodexAppServerChild;

  return new CodexAppServerRun(child, options);
}

export function buildCodexAppServerArgs(): string[] {
  return [
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="all"',
  ];
}

class CodexAppServerRun implements AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;

  private readonly child: CodexAppServerChild;
  private readonly options: CreateCodexAppServerRunOptions;
  private readonly queue = new AgentEventQueue();
  private readonly pending = new Map<number, RpcPending>();
  private readonly stderrChunks: Buffer[] = [];
  private readonly startedTools = new Set<string>();
  private readonly ready: Promise<void>;
  private nextRequestId = 1;
  private threadId: string | undefined;
  private activeTurnId: string | undefined;
  private pendingAgentMessage: string | undefined;
  private latestUsage: AgentEvent | undefined;
  private lastProtocolError: string | undefined;
  private terminal = false;
  private stopReason: 'interrupted' | undefined;
  private pendingSteers = 0;
  private deferredCompletion: Record<string, unknown> | undefined;
  private steerTail: Promise<void> = Promise.resolve();

  constructor(child: CodexAppServerChild, options: CreateCodexAppServerRunOptions) {
    this.child = child;
    this.options = options;
    this.runId = options.run.runId;
    this.events = this.queue;

    this.attachProcessListeners();
    this.ready = this.bootstrap();
    void this.ready.catch((err) => {
      this.fail(`codex app-server startup failed: ${errorMessage(err)}`);
    });
  }

  async steer(input: AgentSteerInput): Promise<AgentSteerResult> {
    let result: AgentSteerResult = { accepted: false, reason: 'turn-not-active' };
    const operation = this.steerTail.then(async () => {
      try {
        await this.ready;
      } catch (err) {
        result = { accepted: false, reason: errorMessage(err) };
        return;
      }
      if (this.terminal || !this.threadId || !this.activeTurnId) return;

      this.pendingSteers++;
      try {
        const response = recordValue(await this.request('turn/steer', {
          threadId: this.threadId,
          expectedTurnId: this.activeTurnId,
          input: userInput(input.prompt, input.images),
          ...(input.clientUserMessageId
            ? { clientUserMessageId: input.clientUserMessageId }
            : {}),
        }));
        const returnedTurnId = stringValue(response?.turnId);
        if (!returnedTurnId || returnedTurnId !== this.activeTurnId) {
          result = { accepted: false, reason: 'unexpected-turn-id' };
          return;
        }
        result = { accepted: true };
      } catch (err) {
        const reason = errorMessage(err);
        log.info('agent', 'steer-rejected', {
          runId: this.runId,
          threadId: this.threadId,
          turnId: this.activeTurnId,
          reason,
        });
        result = { accepted: false, reason };
      } finally {
        this.pendingSteers = Math.max(0, this.pendingSteers - 1);
        this.flushDeferredCompletion();
      }
    });
    this.steerTail = operation.catch(() => {});
    await operation;
    return result;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.stopReason = 'interrupted';

    if (!this.terminal) {
      const interrupt = this.ready.then(async () => {
        if (!this.threadId || !this.activeTurnId || this.terminal) return;
        await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId });
      }).catch(() => {});
      await Promise.race([interrupt, delay(300)]);
    }

    if (this.child.exitCode === null && this.child.signalCode === null) {
      log.info('agent', 'stop-sigterm', {
        pid: this.child.pid ?? null,
        graceMs: this.options.stopGraceMs,
      });
      this.child.kill('SIGTERM');
    }
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          log.warn('agent', 'stop-sigkill', {
            pid: this.child.pid ?? null,
            graceMs: this.options.stopGraceMs,
            reason: 'grace-period-expired',
          });
          this.child.kill('SIGKILL');
        }
        resolve();
      }, this.options.stopGraceMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    return waitForProcessExit(this.child, timeoutMs);
  }

  private attachProcessListeners(): void {
    const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrChunks.push(chunk);
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) log.warn('agent', 'stderr', { line });
      }
    });
    this.child.stdin.on('error', (err) => {
      if (!this.terminal) this.fail(`codex app-server stdin failed: ${err.message}`);
    });
    this.child.on('error', (err) => {
      if (!this.terminal) this.fail(`failed to spawn codex app-server: ${err.message}`);
    });
    this.child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: this.child.pid ?? null, code, signal });
      this.rejectPending(new Error(`codex app-server exited (${code ?? signal ?? 'unknown'})`));
      if (this.terminal) return;
      if (this.stopReason) {
        this.emitTerminal([
          ...this.flushPendingAgentMessage(false),
          { type: 'done', threadId: this.threadId, terminationReason: this.stopReason },
        ]);
        return;
      }
      const stderr = Buffer.concat(this.stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
      this.fail(
        `codex app-server exited before turn completion (${code ?? signal ?? 'unknown'})${detail}`,
        false,
      );
    });
  }

  private async bootstrap(): Promise<void> {
    if (!this.child.pid) {
      throw new Error('spawn returned no pid');
    }
    await this.request('initialize', {
      clientInfo: {
        name: 'lark-channel-bridge',
        title: 'Lark Channel Bridge',
        version: 'steer-v1',
      },
      capabilities: {},
    });
    this.notify('initialized', {});

    const run = this.options.run;
    const threadMethod = run.threadId ? 'thread/resume' : 'thread/start';
    const threadResponse = recordValue(await this.request(threadMethod, {
      ...(run.threadId ? { threadId: run.threadId } : {}),
      cwd: run.cwd,
      approvalPolicy: 'never',
      sandbox: run.sandbox,
      ...(run.model ? { model: run.model } : {}),
      config: {
        approval_policy: 'never',
        shell_environment_policy: { inherit: 'all' },
      },
    }));
    const thread = recordValue(threadResponse?.thread);
    this.threadId = stringValue(thread?.id) ?? run.threadId;
    if (!this.threadId) throw new Error(`${threadMethod} returned no thread id`);

    this.queue.push({
      type: 'system',
      threadId: this.threadId,
      cwd: stringValue(threadResponse?.cwd) ?? run.cwd,
      ...(stringValue(threadResponse?.model)
        ? { model: stringValue(threadResponse?.model) }
        : {}),
    });

    const turnResponse = recordValue(await this.request('turn/start', {
      threadId: this.threadId,
      input: userInput(this.options.initialPrompt, run.images),
      cwd: run.cwd,
      approvalPolicy: 'never',
      ...(run.model ? { model: run.model } : {}),
      ...(run.reasoningEffort ? { effort: run.reasoningEffort } : {}),
    }));
    this.activeTurnId = stringValue(recordValue(turnResponse?.turn)?.id);
    if (!this.activeTurnId) throw new Error('turn/start returned no turn id');
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.reject(new Error('codex app-server is not running'));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, 'utf8', (err) => {
          if (!err) return;
          const request = this.pending.get(id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(id);
          request.reject(err);
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      log.warn('agent', 'app-server-invalid-json');
      return;
    }
    const message = recordValue(value);
    if (!message) return;

    if (typeof message.id === 'number' && !message.method) {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      const error = recordValue(message.error);
      if (error) {
        request.reject(new Error(stringValue(error.message) ?? 'codex app-server request failed'));
      } else {
        request.resolve(message.result);
      }
      return;
    }

    // app-server can ask clients for approvals or user input. This bridge runs
    // with approvalPolicy=never and has no synchronous UI for those requests;
    // reject explicitly so a surprising request cannot hang the active turn.
    if (message.id !== undefined && typeof message.method === 'string') {
      this.notifyResponseError(message.id, 'interactive server requests are not supported');
      return;
    }

    const method = stringValue(message.method);
    const params = recordValue(message.params);
    if (!method || !params) return;
    this.handleNotification(method, params);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (this.terminal) return;
    if (method === 'turn/started') {
      const turnId = stringValue(recordValue(params.turn)?.id);
      if (turnId) this.activeTurnId = turnId;
      return;
    }
    if (method === 'item/reasoning/summaryTextDelta') {
      const delta = stringValue(params.delta);
      if (delta) this.queue.push({ type: 'thinking', delta });
      return;
    }
    if (method === 'item/started') {
      this.handleItemStarted(recordValue(params.item));
      return;
    }
    if (method === 'item/completed') {
      this.handleItemCompleted(recordValue(params.item));
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = recordValue(recordValue(params.tokenUsage)?.last);
      if (usage) {
        this.latestUsage = {
          type: 'usage',
          inputTokens: numberValue(usage.inputTokens),
          outputTokens: numberValue(usage.outputTokens),
          cachedInputTokens: numberValue(usage.cachedInputTokens),
          reasoningOutputTokens: numberValue(usage.reasoningOutputTokens),
        };
      }
      return;
    }
    if (method === 'turn/completed') {
      const turn = recordValue(params.turn);
      const turnId = stringValue(turn?.id);
      if (turnId && this.activeTurnId && turnId !== this.activeTurnId) return;
      if (this.pendingSteers > 0) {
        this.deferredCompletion = turn;
      } else {
        this.completeTurn(turn);
      }
      return;
    }
    if (method === 'error') {
      const error = recordValue(params.error);
      this.lastProtocolError = stringValue(error?.message) ?? stringValue(params.message);
      if (this.lastProtocolError) {
        log.warn('agent', 'app-server-error', { message: this.lastProtocolError });
      }
    }
  }

  private handleItemStarted(item: Record<string, unknown> | undefined): void {
    if (!item || item.type !== 'commandExecution') return;
    const id = stringValue(item.id);
    if (!id || this.startedTools.has(id)) return;
    this.startedTools.add(id);
    this.flushPendingAgentMessageAsText();
    this.queue.push({
      type: 'tool_use',
      id,
      name: 'command_execution',
      input: { command: stringValue(item.command) ?? '' },
    });
  }

  private handleItemCompleted(item: Record<string, unknown> | undefined): void {
    if (!item) return;
    if (item.type === 'agentMessage') {
      const text = stringValue(item.text);
      if (!text || text === this.pendingAgentMessage) return;
      this.flushPendingAgentMessageAsText();
      this.pendingAgentMessage = text;
      return;
    }
    if (item.type !== 'commandExecution') return;
    const id = stringValue(item.id);
    if (!id) return;
    this.startedTools.delete(id);
    this.queue.push({
      type: 'tool_result',
      id,
      output: stringValue(item.aggregatedOutput) ?? '',
      isError: item.status === 'failed' || item.status === 'declined'
        || (numberValue(item.exitCode) !== undefined && numberValue(item.exitCode) !== 0),
    });
  }

  private completeTurn(turn: Record<string, unknown> | undefined): void {
    const status = stringValue(turn?.status) ?? 'completed';
    if (status === 'failed') {
      const error = recordValue(turn?.error);
      this.fail(stringValue(error?.message) ?? this.lastProtocolError ?? 'codex turn failed');
      return;
    }
    const terminationReason: 'interrupted' | 'normal' =
      status === 'interrupted' ? 'interrupted' : 'normal';
    const events = [
      ...this.flushPendingAgentMessage(true),
      ...(this.latestUsage ? [this.latestUsage] : []),
      {
        type: 'done' as const,
        threadId: this.threadId,
        terminationReason,
      },
    ];
    this.emitTerminal(events);
    this.closeInput();
  }

  private flushDeferredCompletion(): void {
    if (this.pendingSteers > 0 || !this.deferredCompletion || this.terminal) return;
    const turn = this.deferredCompletion;
    this.deferredCompletion = undefined;
    this.completeTurn(turn);
  }

  private flushPendingAgentMessage(asFinal: boolean): AgentEvent[] {
    if (!this.pendingAgentMessage) return [];
    const content = this.pendingAgentMessage;
    this.pendingAgentMessage = undefined;
    return asFinal
      ? [{ type: 'final_text', content }]
      : [{ type: 'text', delta: content }];
  }

  private flushPendingAgentMessageAsText(): void {
    for (const event of this.flushPendingAgentMessage(false)) this.queue.push(event);
  }

  private fail(message: string, closeInput = true): void {
    if (this.terminal) return;
    this.emitTerminal([
      ...this.flushPendingAgentMessage(false),
      { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' },
    ]);
    this.rejectPending(new Error(message));
    if (closeInput) this.closeInput();
  }

  private emitTerminal(events: AgentEvent[]): void {
    if (this.terminal) return;
    this.terminal = true;
    for (const event of events) this.queue.push(event);
    this.queue.close();
  }

  private closeInput(): void {
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) {
      this.child.stdin.end();
    }
  }

  private rejectPending(err: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(err);
    }
    this.pending.clear();
  }

  private notifyResponseError(id: unknown, message: string): void {
    if ((typeof id !== 'number' && typeof id !== 'string') || this.child.stdin.writableEnded) return;
    this.child.stdin.write(`${JSON.stringify({
      id,
      error: { code: -32_000, message },
    })}\n`);
  }
}

class AgentEventQueue implements AsyncIterable<AgentEvent> {
  private readonly buffered: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.buffered.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        const event = this.buffered.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function userInput(prompt: string, images: readonly string[] | undefined): Record<string, unknown>[] {
  return [
    { type: 'text', text: prompt, text_elements: [] },
    ...(images ?? []).map((path) => ({ type: 'localImage', path })),
  ];
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}
