import { describe, it, expect } from "vitest";
import { parseChannelKey, stripThreadSuffix } from "../comms/recipient.js";

describe("parseChannelKey", () => {
  it("parses a discord channel key", () => {
    const result = parseChannelKey("agent:main:discord:channel:123");
    expect(result).toEqual({ surface: "discord", channelId: "123", threadId: null });
  });

  it("parses a discord thread key", () => {
    const result = parseChannelKey("agent:main:discord:channel:123:thread:456");
    expect(result).toEqual({ surface: "discord", channelId: "123", threadId: "456" });
  });

  it("parses a telegram chat key", () => {
    const result = parseChannelKey("agent:main:telegram:chat:456");
    expect(result).toEqual({ surface: "telegram", channelId: "456", threadId: null });
  });

  it("parses a telegram forum topic key", () => {
    const result = parseChannelKey("agent:main:telegram:chat:456:topic:789");
    expect(result).toEqual({ surface: "telegram", channelId: "456", threadId: "789" });
  });

  it("parses a telegram key with a NEGATIVE chat id (critical regression fixture)", () => {
    const result = parseChannelKey("agent:main:telegram:chat:-1001234567");
    expect(result).toEqual({ surface: "telegram", channelId: "-1001234567", threadId: null });
  });

  it("parses a telegram key with a negative chat id AND a topic", () => {
    const result = parseChannelKey("agent:main:telegram:chat:-1001234567:topic:99");
    expect(result).toEqual({ surface: "telegram", channelId: "-1001234567", threadId: "99" });
  });

  it("returns null for a non-matching key", () => {
    expect(parseChannelKey("task-agent:foo")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseChannelKey(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseChannelKey(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseChannelKey("")).toBeNull();
  });
});

describe("stripThreadSuffix", () => {
  it("strips a :thread:<id> suffix from a discord key", () => {
    expect(stripThreadSuffix("agent:main:discord:channel:123:thread:456"))
      .toBe("agent:main:discord:channel:123");
  });

  it("strips a :topic:<id> suffix from a telegram key", () => {
    expect(stripThreadSuffix("agent:main:telegram:chat:-1001234567:topic:99"))
      .toBe("agent:main:telegram:chat:-1001234567");
  });

  it("leaves a bare channel key unchanged", () => {
    expect(stripThreadSuffix("agent:main:discord:channel:123"))
      .toBe("agent:main:discord:channel:123");
  });

  it("leaves a bare telegram chat key unchanged", () => {
    expect(stripThreadSuffix("agent:main:telegram:chat:456"))
      .toBe("agent:main:telegram:chat:456");
  });
});
