import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs and logger before importing the module
vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import * as fs from 'fs';
import { getEngine, setEngine, resolveEngineEnv } from '../telegram/engine.js';

describe('telegram/engine.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── getEngine ────────────────────────────────────────────────────
  describe('getEngine()', () => {
    it('returns "claude" when store file is empty (empty string)', () => {
      fs.default.readFileSync.mockReturnValue('');
      expect(getEngine('unknown-chat')).toBe('claude');
    });

    it('returns "claude" when store file does not exist (throws ENOENT)', () => {
      fs.default.readFileSync.mockImplementation(() => {
        const err = new Error('ENOENT: no such file');
        err.code = 'ENOENT';
        throw err;
      });
      expect(getEngine('unknown-chat')).toBe('claude');
    });

    it('returns "claude" when store file does not exist (throws without code)', () => {
      fs.default.readFileSync.mockImplementation(() => {
        throw new Error('some read error');
      });
      expect(getEngine('unknown-chat')).toBe('claude');
    });

    it('returns stored value when chatKey exists in store', () => {
      const store = { 'chat-123': 'qwen', 'chat-456': 'claude' };
      fs.default.readFileSync.mockReturnValue(JSON.stringify(store, null, 2));
      expect(getEngine('chat-123')).toBe('qwen');
      expect(getEngine('chat-456')).toBe('claude');
    });

    it('returns "claude" for unknown chatKey even when store has other keys', () => {
      const store = { 'chat-123': 'qwen' };
      fs.default.readFileSync.mockReturnValue(JSON.stringify(store, null, 2));
      expect(getEngine('unknown-chat')).toBe('claude');
    });
  });

  // ── setEngine ────────────────────────────────────────────────────
  describe('setEngine()', () => {
    it('throws on invalid engine "gpt"', () => {
      expect(() => setEngine('chat-1', 'gpt')).toThrow(/invalid|not allowed|engine/i);
    });

    it('throws on invalid engine "gemini"', () => {
      expect(() => setEngine('chat-1', 'gemini')).toThrow(/invalid|not allowed|engine/i);
    });

    it('accepts "claude" without throwing', () => {
      expect(() => setEngine('chat-1', 'claude')).not.toThrow();
    });

    it('accepts "qwen" without throwing', () => {
      expect(() => setEngine('chat-1', 'qwen')).not.toThrow();
    });

    it('persists "qwen" to the store file (assert via writeFileSync)', () => {
      fs.default.readFileSync.mockReturnValue('{}');
      setEngine('chat-99', 'qwen');
      const written = JSON.parse(fs.default.writeFileSync.mock.calls[0][1]);
      expect(written['chat-99']).toBe('qwen');
    });

    it('persists "claude" to the store file', () => {
      fs.default.readFileSync.mockReturnValue('{}');
      setEngine('chat-88', 'claude');
      const written = JSON.parse(fs.default.writeFileSync.mock.calls[0][1]);
      expect(written['chat-88']).toBe('claude');
    });

    it('preserves existing keys when setting a new one', () => {
      const existing = { 'chat-a': 'qwen' };
      fs.default.readFileSync.mockReturnValue(JSON.stringify(existing, null, 2));
      setEngine('chat-b', 'claude');
      const written = JSON.parse(fs.default.writeFileSync.mock.calls[0][1]);
      expect(written['chat-a']).toBe('qwen');
      expect(written['chat-b']).toBe('claude');
    });
  });

  // ── resolveEngineEnv ─────────────────────────────────────────────
  describe('resolveEngineEnv()', () => {
    it('returns {} for "claude"', () => {
      expect(resolveEngineEnv('claude')).toEqual({});
    });

    it('returns env object for "qwen" with ANTHROPIC_BASE_URL matching /^http:\/\//', () => {
      const env = resolveEngineEnv('qwen');
      expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\//);
    });

    it('returns env object for "qwen" with ANTHROPIC_AUTH_TOKEN === "lmstudio"', () => {
      const env = resolveEngineEnv('qwen');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('lmstudio');
    });

    it('returns env object for "qwen" with model as string', () => {
      const env = resolveEngineEnv('qwen');
      expect(typeof env.model).toBe('string');
    });

    it('qwen env uses JARVIS_LMS_BASE_URL env var when set', () => {
      process.env.JARVIS_LMS_BASE_URL = 'http://custom-host:9999';
      const env = resolveEngineEnv('qwen');
      expect(env.ANTHROPIC_BASE_URL).toBe('http://custom-host:9999');
      delete process.env.JARVIS_LMS_BASE_URL;
    });

    it('qwen env uses JARVIS_LMS_MODEL env var when set', () => {
      process.env.JARVIS_LMS_MODEL = 'custom/model';
      const env = resolveEngineEnv('qwen');
      expect(env.model).toBe('custom/model');
      delete process.env.JARVIS_LMS_MODEL;
    });
  });
});
