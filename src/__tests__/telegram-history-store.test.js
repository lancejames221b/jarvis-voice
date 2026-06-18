import os from 'os';
import fs from 'fs';
import { describe, it, expect, beforeEach } from 'vitest';

// Each test file gets its own temp store path so tests are isolated.
const STORE_PATH = `${os.tmpdir()}/telegram-history-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;

// Set env BEFORE importing the module so getStorePath picks it up.
process.env.TELEGRAM_HISTORY_STORE = STORE_PATH;

// Delete any leftover temp file from a crashed previous run.
try { fs.unlinkSync(STORE_PATH); } catch { /* ignore */ }

import { loadHistory, pushHistory, clearHistory, HISTORY_CAP, resetCache } from '../telegram/history-store.js';

describe('telegram/history-store', () => {
  beforeEach(() => {
    resetCache();
  });

  it('HISTORY_CAP is 20', () => {
    expect(HISTORY_CAP).toBe(20);
  });

  it('round-trip: push 3 entries then loadHistory returns them in order', () => {
    const key = 'rt-1';
    pushHistory(key, 'user', 'hello');
    pushHistory(key, 'assistant', 'hi there');
    pushHistory(key, 'user', 'how are you');

    const entries = loadHistory(key);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ role: 'user', content: 'hello' });
    expect(entries[1]).toEqual({ role: 'assistant', content: 'hi there' });
    expect(entries[2]).toEqual({ role: 'user', content: 'how are you' });
  });

  it('persistence across simulated restart: JSON on disk contains the entries', () => {
    const key = 'persist-1';
    pushHistory(key, 'user', 'first message');
    pushHistory(key, 'assistant', 'first reply');

    // Simulate a restart: delete the in-memory cache and re-import.
    // Since we can't easily force a re-import in ES modules, we'll
    // verify the disk file directly.
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const store = JSON.parse(raw);
    expect(store[key]).toHaveLength(2);
    expect(store[key][0]).toEqual({ role: 'user', content: 'first message' });
    expect(store[key][1]).toEqual({ role: 'assistant', content: 'first reply' });
  });

  it('cap: push 25 entries, loadHistory returns exactly 20 most-recent', () => {
    const key = 'cap-1';
    for (let i = 0; i < 25; i++) {
      pushHistory(key, 'user', `msg-${i}`);
    }
    const entries = loadHistory(key);
    expect(entries).toHaveLength(20);
    // Oldest should be msg-5 (dropped msg-0..4), newest is msg-24
    expect(entries[0]).toEqual({ role: 'user', content: 'msg-5' });
    expect(entries[19]).toEqual({ role: 'user', content: 'msg-24' });
  });

  it('clearHistory empties that chat and the change is on disk', () => {
    const key = 'clear-1';
    pushHistory(key, 'user', 'before clear');
    pushHistory(key, 'assistant', 'still here');

    clearHistory(key);

    const entries = loadHistory(key);
    expect(entries).toEqual([]);

    // Verify on disk too
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const store = JSON.parse(raw);
    expect(store[key]).toBeUndefined();
  });

  it('unknown/missing chatKey: loadHistory returns [] and does not throw', () => {
    expect(() => loadHistory('nonexistent-key-xyz')).not.toThrow();
    expect(loadHistory('nonexistent-key-xyz')).toEqual([]);
  });
});
