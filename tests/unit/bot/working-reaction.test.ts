import type { LarkChannel } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { WorkingReaction } from '../../../src/bot/reaction';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness() {
  const addReaction = vi.fn<(messageId: string, emoji: string) => Promise<string>>()
    .mockResolvedValue('reaction');
  const removeReaction = vi.fn().mockResolvedValue(undefined);
  const indicator = new WorkingReaction({ addReaction, removeReaction } as unknown as LarkChannel);
  return { addReaction, removeReaction, indicator };
}

describe('working reaction lifecycle', () => {
  it('keeps the previous indicator when adding its replacement fails', async () => {
    const h = harness();
    h.indicator.moveTo('first');
    await flush();
    h.addReaction.mockRejectedValueOnce(new Error('unavailable'));
    h.indicator.moveTo('second');
    await flush();
    expect(h.removeReaction).not.toHaveBeenCalled();
    h.indicator.finish();
    expect(h.removeReaction).toHaveBeenCalledWith('first', 'reaction');
  });

  it('removes a late addition after completion without reviving the indicator', async () => {
    const h = harness();
    const addition = deferred<string>();
    h.addReaction.mockReturnValueOnce(addition.promise);
    h.indicator.moveTo('first');
    h.indicator.finish();
    h.indicator.moveTo('after-completion');
    addition.resolve('late');
    await flush();
    expect(h.addReaction).toHaveBeenCalledTimes(1);
    expect(h.removeReaction).toHaveBeenCalledWith('first', 'late');
  });

  it('cleans up out-of-order additions without removing the latest indicator', async () => {
    const h = harness();
    const first = deferred<string>();
    const second = deferred<string>();
    h.addReaction.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    h.indicator.moveTo('first');
    h.indicator.moveTo('second');
    second.resolve('new');
    await flush();
    first.resolve('old');
    await flush();
    expect(h.removeReaction.mock.calls).toEqual([['first', 'old']]);
    h.indicator.finish();
    expect(h.removeReaction.mock.calls).toEqual([['first', 'old'], ['second', 'new']]);
  });
});
