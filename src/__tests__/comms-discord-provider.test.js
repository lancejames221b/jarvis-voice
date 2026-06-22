/**
 * comms-discord-provider.test.js
 *
 * Unit tests for src/comms/providers/discord.js — makeDiscordProvider().
 * Uses a FAKE injected client; never hits real Discord.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { makeDiscordProvider } from '../comms/providers/discord.js';

// ── Fake client helpers ───────────────────────────────────────────────────────

/**
 * Build a fake Discord channel stub with a spy `send` method.
 */
function makeChannel(id = '111') {
  return {
    id,
    send: vi.fn(async (opts) => ({ id: 'msg-' + id, ...opts })),
    sendTyping: vi.fn(async () => {}),
  };
}

/**
 * Build a fake Discord client whose channels.cache.get returns `channel`.
 */
function makeClient(channel) {
  return {
    channels: {
      cache: {
        get: vi.fn((id) => (id === channel.id ? channel : undefined)),
      },
      fetch: vi.fn(async (id) => (id === channel.id ? channel : null)),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('makeDiscordProvider', () => {
  let channel;
  let client;
  let provider;

  beforeEach(() => {
    channel = makeChannel('999');
    client = makeClient(channel);
    provider = makeDiscordProvider({ client });
  });

  // ── capabilities() ─────────────────────────────────────────────────────────

  describe('capabilities()', () => {
    it('returns surface discord', () => {
      const caps = provider.capabilities({ surface: 'discord', kind: 'channel', id: '999' });
      expect(caps.surface).toBe('discord');
    });

    it('returns maxLen 2000', () => {
      const caps = provider.capabilities({ surface: 'discord', kind: 'channel', id: '999' });
      expect(caps.maxLen).toBe(2000);
    });

    it('returns supportsMarkdown true', () => {
      const caps = provider.capabilities({ surface: 'discord', kind: 'channel', id: '999' });
      expect(caps.supportsMarkdown).toBe(true);
    });

    it('returns canAttachFiles true', () => {
      const caps = provider.capabilities({ surface: 'discord', kind: 'channel', id: '999' });
      expect(caps.canAttachFiles).toBe(true);
    });
  });

  // ── send() — text only ─────────────────────────────────────────────────────

  describe('send() — text only', () => {
    it('sends a simple text message to the channel', async () => {
      const recipient = { surface: 'discord', kind: 'channel', id: '999' };
      const msg = { text: 'Hello Discord' };
      const caps = provider.capabilities(recipient);

      const result = await provider.send(recipient, msg, caps);

      expect(channel.send).toHaveBeenCalledOnce();
      const call = channel.send.mock.calls[0][0];
      expect(call.content).toBe('Hello Discord');
      expect(result.channelId).toBe('999');
      expect(result.messageId).toBeTruthy();
    });

    it('channels.cache miss falls back to channels.fetch', async () => {
      // Make cache miss
      client.channels.cache.get = vi.fn(() => undefined);
      client.channels.fetch = vi.fn(async () => channel);

      const recipient = { surface: 'discord', kind: 'channel', id: '999' };
      const msg = { text: 'Fetched channel' };
      const caps = provider.capabilities(recipient);

      await provider.send(recipient, msg, caps);

      expect(client.channels.fetch).toHaveBeenCalledWith('999');
      expect(channel.send).toHaveBeenCalledOnce();
    });
  });

  // ── send() — with attachment ───────────────────────────────────────────────

  describe('send() — with AgnosticFile attachment', () => {
    it('produces a send call with files array of length 1 for a path-based file', async () => {
      // Create a real /tmp test file so AttachmentBuilder won't throw
      const tmpPath = '/tmp/discord-provider-test.png';
      fs.writeFileSync(tmpPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      try {
        const recipient = { surface: 'discord', kind: 'channel', id: '999' };
        const msg = {
          text: 'Here is the file',
          attachments: [{ kind: 'image', path: tmpPath, name: 'test.png', mime: 'image/png' }],
        };
        const caps = provider.capabilities(recipient);

        await provider.send(recipient, msg, caps);

        expect(channel.send).toHaveBeenCalledOnce();
        const callOpts = channel.send.mock.calls[0][0];
        expect(callOpts.files).toHaveLength(1);
        expect(callOpts.content).toBe('Here is the file');
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    });

    it('produces a send call with files array for a buffer-based file', async () => {
      const recipient = { surface: 'discord', kind: 'channel', id: '999' };
      const msg = {
        text: 'Buffer file',
        attachments: [
          { kind: 'image', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), name: 'buf.png' },
        ],
      };
      const caps = provider.capabilities(recipient);

      await provider.send(recipient, msg, caps);

      expect(channel.send).toHaveBeenCalledOnce();
      const callOpts = channel.send.mock.calls[0][0];
      expect(callOpts.files).toHaveLength(1);
    });
  });

  // ── send() — chunking ──────────────────────────────────────────────────────

  describe('send() — long text chunking', () => {
    it('chunks text longer than maxLen into multiple sends, files only on first', async () => {
      const tmpPath = '/tmp/discord-provider-chunk-test.png';
      fs.writeFileSync(tmpPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      try {
        // Build a text that will produce exactly 2 chunks at maxLen=2000.
        // Use 4000 chars of 'a' with a newline at 2000 so chunker can split cleanly.
        const longText = 'a'.repeat(1999) + '\n' + 'b'.repeat(1999);

        const recipient = { surface: 'discord', kind: 'channel', id: '999' };
        const msg = {
          text: longText,
          attachments: [{ kind: 'image', path: tmpPath, name: 'chunk-test.png', mime: 'image/png' }],
        };
        const caps = provider.capabilities(recipient); // maxLen: 2000

        await provider.send(recipient, msg, caps);

        // Should have 2 send calls (2 chunks)
        expect(channel.send).toHaveBeenCalledTimes(2);

        // First call should have files
        const firstCallOpts = channel.send.mock.calls[0][0];
        expect(firstCallOpts.files).toHaveLength(1);

        // Second call should be text-only (no files key or empty)
        const secondCallOpts = channel.send.mock.calls[1][0];
        expect(secondCallOpts.files).toBeUndefined();
        expect(secondCallOpts.content).toBeTruthy();
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    });
  });

  // ── send() — embed ─────────────────────────────────────────────────────────

  describe('send() — with embed', () => {
    it('passes an embed on the first chunk when msg.embed is set', async () => {
      const recipient = { surface: 'discord', kind: 'channel', id: '999' };
      const msg = {
        text: 'Status update',
        embed: {
          title: 'Jarvis Status',
          fields: [{ name: 'State', value: 'Running' }],
        },
      };
      const caps = provider.capabilities(recipient);

      await provider.send(recipient, msg, caps);

      expect(channel.send).toHaveBeenCalledOnce();
      const callOpts = channel.send.mock.calls[0][0];
      expect(callOpts.embeds).toHaveLength(1);
    });
  });

  // ── surface property ───────────────────────────────────────────────────────

  it('has surface property discord', () => {
    expect(provider.surface).toBe('discord');
  });
});
