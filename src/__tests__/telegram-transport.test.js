import { describe, it, expect, vi } from 'vitest';
import { normalizeUpdate, splitSend } from '../telegram/transport.js';

describe('normalizeUpdate', () => {
  it('extracts a neutral shape from a basic message', () => {
    const msg = {
      message_id: 9,
      from: { id: 555 },
      chat: { id: 111 },
      text: 'hello',
    };
    expect(normalizeUpdate(msg)).toEqual({
      userId: '555', chatId: '111', topicId: null, text: 'hello', messageId: '9',
    });
  });
  it('captures a forum topic id when present', () => {
    const msg = {
      message_id: 9, from: { id: 555 }, chat: { id: 111 },
      message_thread_id: 222, text: 'hi',
    };
    expect(normalizeUpdate(msg).topicId).toBe('222');
  });
  it('returns null for a message with no text (e.g. a sticker)', () => {
    expect(normalizeUpdate({ message_id: 9, from: { id: 5 }, chat: { id: 1 } })).toBeNull();
  });
});

describe('splitSend', () => {
  it('calls the sender once for a short message', async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    await splitSend(sender, '111', 'short', { topicId: null });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith('111', 'short', {});
  });
  it('passes message_thread_id through when a topic is set', async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    await splitSend(sender, '111', 'x', { topicId: '222' });
    expect(sender).toHaveBeenCalledWith('111', 'x', { message_thread_id: '222' });
  });
});
