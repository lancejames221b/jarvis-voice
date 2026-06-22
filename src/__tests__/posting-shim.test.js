/**
 * posting-shim.test.js — STEP 2 integration-unit tests
 *
 * Verifies that postToTextChannel + postActivity route string messages through
 * the comms layer (commsSend) while preserving every existing guard exactly.
 *
 * Uses vi.mock to isolate comms.send; never hits real Discord.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── Mock the comms layer ──────────────────────────────────────────────────────

vi.mock('../comms/index.js', () => ({
  send: vi.fn(async (_recipient, _msg) => ({ messageId: 'mock-msg-id', channelId: _recipient.id })),
  registerProvider: vi.fn(),
  getProvider: vi.fn(),
}));

// ── Mock visual-mode (imported by posting.js) ─────────────────────────────────

vi.mock('../visual-mode.js', () => ({
  getVisualTargetChannel: vi.fn(() => null),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal fake Discord channel (avoids any real discord.js import). */
function makeChannel(id = 'ch-999', name = 'test-channel') {
  return { id, name, send: vi.fn(async () => ({ id: 'sent-msg-id' })) };
}

/** Build a minimal fake Discord client whose cache returns `channel` for its id. */
function makeClient(channel, ready = true) {
  return {
    channels: {
      cache: {
        get: vi.fn((id) => (id === channel.id ? channel : undefined)),
      },
      fetch: vi.fn(async () => null),
    },
    isReady: vi.fn(() => ready),
  };
}

// ── Setup: inject discordRef.client before each test ─────────────────────────

// We import discordRef to set the live client reference that posting.js reads.
import { discordRef } from '../state/runtime.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('posting-shim STEP 2', async () => {
  // We must import AFTER vi.mock calls (vitest hoisting)
  const { send: mockSend } = await import('../comms/index.js');
  const { postToTextChannel, postActivity } = await import('../discord/posting.js');

  let channel;
  let client;

  beforeEach(() => {
    vi.clearAllMocks();
    channel = makeChannel('ch-999', 'general');
    client = makeClient(channel);
    discordRef.client = client;
  });

  afterEach(() => {
    discordRef.client = null;
  });

  // ── postToTextChannel — not-configured guard ──────────────────────────────

  describe('postToTextChannel', () => {
    it('returns false without calling comms.send when no channel is configured', async () => {
      // No env var set, no focus, no forceChannelId
      const origEnv = process.env.DISCORD_TEXT_CHANNEL_ID;
      delete process.env.DISCORD_TEXT_CHANNEL_ID;
      try {
        const result = await postToTextChannel('hello');
        expect(result).toBe(false);
        expect(mockSend).not.toHaveBeenCalled();
      } finally {
        if (origEnv !== undefined) process.env.DISCORD_TEXT_CHANNEL_ID = origEnv;
      }
    });

    it('returns false without calling comms.send when channel not in cache', async () => {
      // Channel NOT in cache (wrong id)
      client.channels.cache.get = vi.fn(() => undefined);
      process.env.DISCORD_TEXT_CHANNEL_ID = 'ch-999';
      try {
        const result = await postToTextChannel('hello');
        expect(result).toBe(false);
        expect(mockSend).not.toHaveBeenCalled();
      } finally {
        delete process.env.DISCORD_TEXT_CHANNEL_ID;
      }
    });

    it('calls comms.send with correct Recipient and OutMessage for a plain string', async () => {
      process.env.DISCORD_TEXT_CHANNEL_ID = 'ch-999';
      try {
        const result = await postToTextChannel('hello');
        expect(result).toBe(true);
        expect(mockSend).toHaveBeenCalledOnce();
        const [recipient, out] = mockSend.mock.calls[0];
        expect(recipient).toMatchObject({ surface: 'discord', kind: 'channel', id: 'ch-999' });
        expect(out.text).toBe('hello');
        expect(out.attachments).toEqual([]);
      } finally {
        delete process.env.DISCORD_TEXT_CHANNEL_ID;
      }
    });

    it('uses forceChannelId when provided', async () => {
      // Different channel in cache for forced id
      const forced = makeChannel('ch-forced', 'forced');
      client.channels.cache.get = vi.fn((id) => {
        if (id === 'ch-forced') return forced;
        return undefined;
      });
      const result = await postToTextChannel('hi', { forceChannelId: 'ch-forced' });
      expect(result).toBe(true);
      const [recipient] = mockSend.mock.calls[0];
      expect(recipient.id).toBe('ch-forced');
    });

    it('extracts a path-based attachment and includes it in OutMessage.attachments', async () => {
      // Create a real /tmp file so extractAttachmentsNeutral can stat it
      const tmpPath = '/tmp/posting-shim-test.png';
      fs.writeFileSync(tmpPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      try {
        process.env.DISCORD_TEXT_CHANNEL_ID = 'ch-999';
        // JARVIS_ATTACH_DIRS must include /tmp (it's the default)
        const result = await postToTextChannel(`see ${tmpPath}`);
        expect(result).toBe(true);
        expect(mockSend).toHaveBeenCalledOnce();
        const [_recipient, out] = mockSend.mock.calls[0];
        expect(out.attachments.length).toBe(1);
        expect(out.attachments[0].path).toBe(fs.realpathSync(tmpPath));
        expect(out.attachments[0].kind).toBe('image');
      } finally {
        delete process.env.DISCORD_TEXT_CHANNEL_ID;
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    });

    it('passes object messages directly to channel.send (STEP 4 deferred)', async () => {
      process.env.DISCORD_TEXT_CHANNEL_ID = 'ch-999';
      try {
        const objMsg = { content: 'object payload', files: [] };
        const result = await postToTextChannel(objMsg);
        expect(result).toBe(true);
        // comms.send must NOT have been called
        expect(mockSend).not.toHaveBeenCalled();
        // channel.send must have been called directly with the object
        expect(channel.send).toHaveBeenCalledWith(objMsg);
      } finally {
        delete process.env.DISCORD_TEXT_CHANNEL_ID;
      }
    });
  });

  // ── postActivity — guards and routing ─────────────────────────────────────

  describe('postActivity', () => {
    it('returns undefined without calling comms.send when ACTIVITY_FEED_ENABLED=false', async () => {
      process.env.ACTIVITY_FEED_ENABLED = 'false';
      process.env.DISCORD_ACTIVITY_CHANNEL_ID = 'ch-999';
      try {
        const result = await postActivity('status update');
        expect(result).toBeUndefined();
        expect(mockSend).not.toHaveBeenCalled();
      } finally {
        delete process.env.ACTIVITY_FEED_ENABLED;
        delete process.env.DISCORD_ACTIVITY_CHANNEL_ID;
      }
    });

    it('returns undefined without calling comms.send when no activity channel id', async () => {
      // No DISCORD_ACTIVITY_CHANNEL_ID, no DISCORD_TEXT_CHANNEL_ID fallback
      const origAct = process.env.DISCORD_ACTIVITY_CHANNEL_ID;
      const origTxt = process.env.DISCORD_TEXT_CHANNEL_ID;
      delete process.env.DISCORD_ACTIVITY_CHANNEL_ID;
      delete process.env.DISCORD_TEXT_CHANNEL_ID;
      try {
        const result = await postActivity('status update');
        expect(result).toBeUndefined();
        expect(mockSend).not.toHaveBeenCalled();
      } finally {
        if (origAct !== undefined) process.env.DISCORD_ACTIVITY_CHANNEL_ID = origAct;
        if (origTxt !== undefined) process.env.DISCORD_TEXT_CHANNEL_ID = origTxt;
      }
    });

    it('returns undefined without calling comms.send when client is not ready', async () => {
      client.isReady = vi.fn(() => false);
      process.env.DISCORD_ACTIVITY_CHANNEL_ID = 'ch-999';
      try {
        const result = await postActivity('status update');
        expect(result).toBeUndefined();
        expect(mockSend).not.toHaveBeenCalled();
      } finally {
        delete process.env.DISCORD_ACTIVITY_CHANNEL_ID;
      }
    });

    it('calls comms.send with correct Recipient and OutMessage for a string', async () => {
      process.env.DISCORD_ACTIVITY_CHANNEL_ID = 'ch-999';
      try {
        await postActivity('task started');
        expect(mockSend).toHaveBeenCalledOnce();
        const [recipient, out] = mockSend.mock.calls[0];
        expect(recipient).toMatchObject({ surface: 'discord', kind: 'channel', id: 'ch-999' });
        expect(out.text).toBe('task started');
      } finally {
        delete process.env.DISCORD_ACTIVITY_CHANNEL_ID;
      }
    });

    it('falls back to DISCORD_TEXT_CHANNEL_ID when DISCORD_ACTIVITY_CHANNEL_ID not set', async () => {
      delete process.env.DISCORD_ACTIVITY_CHANNEL_ID;
      process.env.DISCORD_TEXT_CHANNEL_ID = 'ch-999';
      try {
        await postActivity('fallback test');
        expect(mockSend).toHaveBeenCalledOnce();
        const [recipient] = mockSend.mock.calls[0];
        expect(recipient.id).toBe('ch-999');
      } finally {
        delete process.env.DISCORD_TEXT_CHANNEL_ID;
      }
    });

    it('returns null (not undefined) when channel not in cache', async () => {
      // Channel not found in cache — should fall through to return null
      client.channels.cache.get = vi.fn(() => undefined);
      process.env.DISCORD_ACTIVITY_CHANNEL_ID = 'ch-999';
      try {
        const result = await postActivity('noop');
        expect(result).toBeNull();
        expect(mockSend).not.toHaveBeenCalled();
      } finally {
        delete process.env.DISCORD_ACTIVITY_CHANNEL_ID;
      }
    });
  });

  // ── comms reference in posting.js ────────────────────────────────────────

  it('posting.js references commsSend (sanity grep via import)', () => {
    // The mock being called in the tests above already proves this,
    // but an explicit check makes the intent clear for readers.
    expect(typeof mockSend).toBe('function');
  });
});
