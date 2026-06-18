import { describe, it, expect, afterEach, vi } from 'vitest';
import { createProgressDraft } from '../telegram/progress.js';

describe('telegram/progress', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('first update() lazily sends exactly one draft message and captures its id', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 'draft-1' });
    const editMessage = vi.fn().mockResolvedValue();
    const draft = createProgressDraft({
      sendMessage, editMessage, chatId: '123', throttleMs: 2000,
    });

    draft.update('starting');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('123', 'starting', {});
    expect(editMessage).not.toHaveBeenCalled();

    // Advance past throttle so the first edit fires
    await vi.advanceTimersByTimeAsync(2000);
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledWith('123', 'draft-1', 'starting', {});

    vi.useRealTimers();
  });

  it('throttle: 5 rapid updates within one window → at most 1 edit; trailing text wins', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 'd1' });
    const editMessage = vi.fn().mockResolvedValue();
    const draft = createProgressDraft({
      sendMessage, editMessage, chatId: '123', throttleMs: 2000,
    });

    // First update sends the draft
    draft.update('starting');
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // 4 more rapid updates within the same throttle window
    draft.update('working');
    draft.update('almost done');
    draft.update('processing');
    draft.update('final');

    // No edits yet — still within the throttle window
    expect(editMessage).not.toHaveBeenCalled();

    // Advance past throttle — exactly ONE edit fires with the LAST text
    await vi.advanceTimersByTimeAsync(2000);
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledWith('123', 'd1', 'final', {});

    vi.useRealTimers();
  });

  it('finalize() flushes pending text via editMessage and is safe to call twice', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 'd2' });
    const editMessage = vi.fn().mockResolvedValue();
    const draft = createProgressDraft({
      sendMessage, editMessage, chatId: '123', throttleMs: 2000,
    });

    draft.update('working');
    // Advance past throttle so the draft message is sent and first edit fires
    await vi.advanceTimersByTimeAsync(2000);
    editMessage.mockClear(); // clear the initial edit from throttle

    // Update with final text, then immediately finalize (before next throttle)
    draft.update('done');
    await draft.finalize();

    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(editMessage).toHaveBeenCalledWith('123', 'd2', 'done', {});

    // Second finalize should be a no-op
    await draft.finalize();
    expect(editMessage).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('rejections from editMessage/sendMessage are swallowed and draft keeps working', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const sendMessage = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('send fail'));
      }
      return Promise.resolve({ message_id: 'd3' });
    });
    const editMessage = vi.fn().mockRejectedValue(new Error('edit fail'));
    const draft = createProgressDraft({
      sendMessage, editMessage, chatId: '123', throttleMs: 1000,
    });

    // First update fails to send — should NOT throw
    expect(() => draft.update('starting')).not.toThrow();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Second update should succeed (sendMessage resolved on retry)
    draft.update('working');

    // Advance past throttle — editMessage rejects but does not escape
    await vi.advanceTimersByTimeAsync(1000);
    expect(editMessage).toHaveBeenCalledTimes(1);

    // Third update should still work — the draft lifecycle is intact
    draft.update('done');
    await vi.advanceTimersByTimeAsync(1000);
    expect(editMessage).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
