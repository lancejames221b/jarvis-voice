/**
 * src/__tests__/memory-category-contract.test.js
 *
 * CONTRACT TEST — Jarvis v2 §2.8
 *
 * Locks the write-side (gateway memoryCategory) and read-side
 * (session-manager getChannelContext) agreement so a future refactor cannot
 * silently break haivemind memory routing.
 *
 * SOURCE LOCATIONS (update BOTH if either changes):
 *   WRITE side: scripts/jarvis-gateway.js  — function memoryCategory(channelKey)
 *   READ  side: src/agent/session-manager.js:402 — category = `channel:${…replace(…)}`
 *
 * This test does NOT import either source file:
 *   - jarvis-gateway.js starts an express server on require and is unsafe in a
 *     unit-test process.
 *   - session-manager.js imports haivemind network dependencies that are not
 *     available in the test environment.
 *
 * Instead, the pure logic is extracted verbatim as local helpers below.
 * If the source logic changes, update the helpers here IN THE SAME PR.
 * Changing one side without the other is the failure mode this test guards.
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// WRITE SIDE — verbatim copy of scripts/jarvis-gateway.js memoryCategory()
//
// Source: scripts/jarvis-gateway.js, function memoryCategory(channelKey)
//   discord key  -> channel:<id>            (regex /discord:channel:(\d+)/)
//   telegram key -> channel:telegram:chat:<id>  (regex /telegram:chat:([\w-]+)/)
//   else         -> null
// ---------------------------------------------------------------------------
function writeCategory(channelKey) {
  const k = String(channelKey || '');
  const d = k.match(/discord:channel:(\d+)/);
  if (d) return `channel:${d[1]}`;
  const t = k.match(/telegram:chat:([\w-]+)/);
  if (t) return `channel:telegram:chat:${t[1]}`;
  return null;
}

// ---------------------------------------------------------------------------
// READ SIDE — verbatim copy of src/agent/session-manager.js:402
//   getChannelContext(channelId) builds:
//     const category = `channel:${String(channelId).replace(/:(thread|topic):[\w-]+$/, '')}`;
//
// Source: src/agent/session-manager.js, function getChannelContext, line ~402
// Note: brain.js passes a SURFACE-APPROPRIATE channelId, not the full channelKey:
//   - Discord: bare numeric id of the parent channel (e.g. "123")
//   - Telegram: telegramChatKey(chatId, topicId) → "telegram:chat:<id>[:topic:<tid>]"
// ---------------------------------------------------------------------------
function readCategory(channelId) {
  return `channel:${String(channelId).replace(/:(thread|topic):[\w-]+$/, '')}`;
}

// ---------------------------------------------------------------------------
// CONTRACT ASSERTIONS
// ---------------------------------------------------------------------------

describe('memoryCategory write/read contract (gateway ↔ session-manager)', () => {

  describe('Discord', () => {
    it('bare channel key: write and read agree → channel:123', () => {
      expect(writeCategory('agent:main:discord:channel:123')).toBe('channel:123');
      expect(readCategory('123')).toBe('channel:123');
      expect(writeCategory('agent:main:discord:channel:123')).toBe(readCategory('123'));
    });

    it('thread key: write strips thread (regex only captures channel id); read receives bare parent id', () => {
      // WRITE: the gateway passes the full thread channelKey to memoryCategory;
      //        /discord:channel:(\d+)/ captures just the channel id, ignoring :thread:.
      expect(writeCategory('agent:main:discord:channel:123:thread:456')).toBe('channel:123');

      // READ: brain.js (message-handlers.js ~line 547-553) passes _mentionParentId,
      //       which for a thread is message.channel.parentId — the parent channel's
      //       bare numeric id (NOT the thread id).  So readCategory receives '123', not
      //       '123:thread:456'.  The :thread: strip in readCategory is a belt-and-
      //       suspenders guard; in Discord's call path it is never needed.
      expect(readCategory('123')).toBe('channel:123');

      // If a caller were to pass the thread-suffixed form, the strip still works:
      expect(readCategory('123:thread:456')).toBe('channel:123');
    });
  });

  describe('Telegram', () => {
    it('bare chat key: write and read agree → channel:telegram:chat:-100999', () => {
      expect(writeCategory('agent:main:telegram:chat:-100999')).toBe('channel:telegram:chat:-100999');
      expect(readCategory('telegram:chat:-100999')).toBe('channel:telegram:chat:-100999');
      expect(writeCategory('agent:main:telegram:chat:-100999')).toBe(readCategory('telegram:chat:-100999'));
    });

    it('topic key: write strips :topic: implicitly; read strips :topic: explicitly', () => {
      // WRITE: /telegram:chat:([\w-]+)/ stops before :topic: so the capture is just -100999.
      expect(writeCategory('agent:main:telegram:chat:-100999:topic:7')).toBe('channel:telegram:chat:-100999');

      // READ: telegram adapter passes telegramChatKey(chatId, topicId) as channelId.
      //       For a forum topic that is "telegram:chat:-100999:topic:7".
      //       The replace strips :topic:7 → 'telegram:chat:-100999'.
      expect(readCategory('telegram:chat:-100999:topic:7')).toBe('channel:telegram:chat:-100999');

      expect(writeCategory('agent:main:telegram:chat:-100999:topic:7'))
        .toBe(readCategory('telegram:chat:-100999:topic:7'));
    });

    it('negative chat id is handled correctly (no sign-stripping)', () => {
      const chatKey = 'agent:main:telegram:chat:-1001234567890';
      expect(writeCategory(chatKey)).toBe('channel:telegram:chat:-1001234567890');
      expect(readCategory('telegram:chat:-1001234567890')).toBe('channel:telegram:chat:-1001234567890');
    });
  });

  describe('unrecognized key', () => {
    it('writeCategory returns null for an unrecognized channelKey', () => {
      expect(writeCategory('task-agent:foo')).toBeNull();
      expect(writeCategory('voice-session')).toBeNull();
      expect(writeCategory('')).toBeNull();
      expect(writeCategory(null)).toBeNull();
    });
  });
});
