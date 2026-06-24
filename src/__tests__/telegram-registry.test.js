import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs and logger before importing the module
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { telegramChatKey, getTelegramProjectPath, registerTelegramChat } from '../telegram/registry.js';

// ── Sample registry ──────────────────────────────────────────────────
const SAMPLE_REGISTRY = {
  discord: {
    'chan-001': {
      name: 'gibson',
      aliases: ['gibson-main', 'main-gibson'],
      directive: 'contexts/gibson.md',
    },
  },
  telegram: {},
};

describe('telegram-registry.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── telegramChatKey ────────────────────────────────────────────────
  describe('telegramChatKey()', () => {
    it('builds a chat-only key when topicId is null', () => {
      expect(telegramChatKey('111', null)).toBe('telegram:chat:111');
    });

    it('builds a chat-only key when topicId is undefined', () => {
      expect(telegramChatKey('111', undefined)).toBe('telegram:chat:111');
    });

    it('builds a topic key when topicId is present', () => {
      expect(telegramChatKey('111', '222')).toBe('telegram:chat:111:topic:222');
    });

    it('handles large numeric chat IDs', () => {
      expect(telegramChatKey('987654321', '42')).toBe('telegram:chat:987654321:topic:42');
    });
  });

  // ── getTelegramProjectPath ─────────────────────────────────────────
  describe('getTelegramProjectPath()', () => {
    it('returns the bound projectPath for a known chat key', () => {
      readFileSync.mockReturnValue(JSON.stringify({
        telegram: { 'telegram:chat:111': { projectPath: '/home/u/proj' } },
      }));
      expect(getTelegramProjectPath('telegram:chat:111')).toBe('/home/u/proj');
    });

    it('returns null when the chat key is not bound', () => {
      readFileSync.mockReturnValue(JSON.stringify({ telegram: {} }));
      expect(getTelegramProjectPath('telegram:chat:999')).toBeNull();
    });

    it('returns null when the registry has no telegram section at all', () => {
      readFileSync.mockReturnValue(JSON.stringify({ discord: {} }));
      expect(getTelegramProjectPath('telegram:chat:111')).toBeNull();
    });

    it('returns null when the registry file is empty object', () => {
      readFileSync.mockReturnValue(JSON.stringify({}));
      expect(getTelegramProjectPath('telegram:chat:111')).toBeNull();
    });
  });

  // ── registerTelegramChat ───────────────────────────────────────────
  describe('registerTelegramChat()', () => {
    it('writes a new telegram binding and preserves existing discord section', () => {
      readFileSync.mockReturnValue(JSON.stringify(SAMPLE_REGISTRY));
      registerTelegramChat('telegram:chat:111', '/home/u/proj');

      const written = JSON.parse(writeFileSync.mock.calls[0][1]);
      expect(written.discord).toEqual(SAMPLE_REGISTRY.discord);
      expect(written.telegram['telegram:chat:111']).toEqual({ projectPath: '/home/u/proj' });
    });

    it('creates the telegram section when absent', () => {
      readFileSync.mockReturnValue(JSON.stringify({ discord: { a: {} } }));
      registerTelegramChat('telegram:chat:111', '/home/u/proj');

      const written = JSON.parse(writeFileSync.mock.calls[0][1]);
      expect(written.discord).toEqual({ a: {} });
      expect(written.telegram).toBeDefined();
      expect(written.telegram['telegram:chat:111']).toEqual({ projectPath: '/home/u/proj' });
    });

    it('merges projectPath into an existing telegram entry without overwriting other fields', () => {
      readFileSync.mockReturnValue(JSON.stringify({
        telegram: {
          'telegram:chat:111': { projectPath: '/old/path', extra: 'value' },
        },
      }));
      registerTelegramChat('telegram:chat:111', '/new/path');

      const written = JSON.parse(writeFileSync.mock.calls[0][1]);
      expect(written.telegram['telegram:chat:111']).toEqual({
        projectPath: '/new/path',
        extra: 'value',
      });
    });
  });
});
