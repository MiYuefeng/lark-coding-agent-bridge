import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

/** Add the working indicator. API failures must never block the reply flow. */
export async function addWorkingReaction(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  try {
    const id = await channel.addReaction(messageId, 'Typing');
    if (id) log.info('reaction', 'added', { messageId, reactionId: id });
    return id;
  } catch (err) {
    log.warn('reaction', 'add-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Remove a previously-added reaction. Tolerates errors silently — best
 * effort cleanup; a leftover reaction is harmless. */
export async function removeReaction(
  channel: LarkChannel,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await channel.removeReaction(messageId, reactionId);
    log.info('reaction', 'removed', { messageId, reactionId });
  } catch (err) {
    log.warn('reaction', 'remove-failed', {
      messageId,
      reactionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** One run owns one indicator, including messages accepted through steering.
 * Adds and removals never block agent output or final delivery. */
export class WorkingReaction {
  private finished = false;
  private target?: string;
  private generation = 0;
  private visible?: { messageId: string; reactionId: string };

  constructor(private readonly channel: LarkChannel) {}

  moveTo(messageId: string): void {
    if (this.finished || this.target === messageId) return;
    this.target = messageId;
    const generation = ++this.generation;
    void addWorkingReaction(this.channel, messageId).then((reactionId) => {
      if (!reactionId) return;
      if (this.finished || generation !== this.generation) {
        void removeReaction(this.channel, messageId, reactionId);
        return;
      }
      const previous = this.visible;
      this.visible = { messageId, reactionId };
      // Keep the old indicator until its replacement has actually appeared.
      if (previous) void removeReaction(this.channel, previous.messageId, previous.reactionId);
    });
  }

  finish(): void {
    this.finished = true;
    const previous = this.visible;
    this.visible = undefined;
    if (previous) void removeReaction(this.channel, previous.messageId, previous.reactionId);
  }
}
