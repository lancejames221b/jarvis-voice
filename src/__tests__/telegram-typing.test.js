import { describe, it, expect, afterEach, vi } from 'vitest';
import { startTyping } from '../telegram/typing.js';

describe('telegram/typing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('immediate fire: sendAction is called once synchronously on start', () => {
    vi.useFakeTimers();
    const sendAction = vi.fn();
    const stop = startTyping({ sendAction, chatId: '123' });
    // tick() is called synchronously before any timer advance
    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(sendAction).toHaveBeenCalledWith('123', {});
    stop();
    vi.useRealTimers();
  });

  it('refresh: after advancing time by 3 intervals, sendAction called 1+3 times', async () => {
    vi.useFakeTimers();
    const sendAction = vi.fn();
    const stop = startTyping({ sendAction, chatId: '123', intervalMs: 5000 });
    expect(sendAction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(sendAction).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(sendAction).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(5000);
    expect(sendAction).toHaveBeenCalledTimes(4);

    stop();
    vi.useRealTimers();
  });

  it('stop halts further calls', async () => {
    vi.useFakeTimers();
    const sendAction = vi.fn();
    const stop = startTyping({ sendAction, chatId: '123', intervalMs: 5000 });
    expect(sendAction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(sendAction).toHaveBeenCalledTimes(2);

    stop();

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    // No more calls after stop
    expect(sendAction).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('idempotent stop: calling stop() twice does not throw', () => {
    vi.useFakeTimers();
    const sendAction = vi.fn();
    const stop = startTyping({ sendAction, chatId: '123' });

    expect(() => { stop(); }).not.toThrow();
    expect(() => { stop(); }).not.toThrow();

    vi.useRealTimers();
  });

  it('resilient: rejected sendAction is swallowed and loop keeps going', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const sendAction = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 2) {
        return Promise.reject(new Error('network flap'));
      }
      return Promise.resolve();
    });

    const stop = startTyping({ sendAction, chatId: '123', intervalMs: 5000 });

    // First call succeeds (immediate)
    expect(sendAction).toHaveBeenCalledTimes(1);

    // Advance to 2nd call which rejects
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendAction).toHaveBeenCalledTimes(2);

    // Advance past the rejection — 3rd call should still fire
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendAction).toHaveBeenCalledTimes(3);

    stop();
    vi.useRealTimers();
  });

  it('topic opts: when topicId is provided, message_thread_id is set', () => {
    vi.useFakeTimers();
    const sendAction = vi.fn();
    const stop = startTyping({ sendAction, chatId: '456', topicId: '789' });

    expect(sendAction).toHaveBeenCalledTimes(1);
    expect(sendAction).toHaveBeenCalledWith('456', { message_thread_id: '789' });

    stop();
    vi.useRealTimers();
  });
});
