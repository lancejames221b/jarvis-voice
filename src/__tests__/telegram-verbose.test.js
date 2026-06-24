import os from 'os';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const STORE_PATH = `${os.tmpdir()}/telegram-verbose-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
process.env.TELEGRAM_VERBOSE_STORE = STORE_PATH;
try { fs.unlinkSync(STORE_PATH); } catch { /* ignore */ }

import { isVerbose, setVerbose, resetCache } from '../telegram/verbose.js';

describe('telegram/verbose', () => {
  beforeEach(() => {
    resetCache();
  });

  afterEach(() => {
    resetCache();
  });

  it('default isVerbose returns false for unknown chat', () => {
    expect(isVerbose('unknown-chat-xyz')).toBe(false);
  });

  it('setVerbose true then isVerbose true; persists to disk', () => {
    const key = 'chat-1';
    setVerbose(key, true);
    expect(isVerbose(key)).toBe(true);

    // Verify on disk
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const store = JSON.parse(raw);
    expect(store[key]).toBe(true);
  });

  it('setVerbose false persists false', () => {
    const key = 'chat-2';
    setVerbose(key, true);
    setVerbose(key, false);
    expect(isVerbose(key)).toBe(false);

    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const store = JSON.parse(raw);
    expect(store[key]).toBe(false);
  });
});
