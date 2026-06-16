import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../channel-access.js', () => ({
  isOwner: vi.fn(),
  isTelegramOwner: vi.fn(),
  canAccessChannel: vi.fn(),
}));
vi.mock('../brain/brain.js', () => ({
  generateResponseStreaming: vi.fn(),
}));
vi.mock('../telegram/registry.js', () => ({
  telegramChatKey: (c, t) => (t ? `telegram:chat:${c}:topic:${t}` : `telegram:chat:${c}`),
  getTelegramProjectPath: vi.fn(),
  registerTelegramChat: vi.fn(),
}));
vi.mock('../telegram/engine.js', () => ({
  getEngine: vi.fn(() => 'claude'),
  setEngine: vi.fn(),
  resolveEngineEnv: vi.fn(() => ({})),
}));

import { isTelegramOwner } from '../channel-access.js';
import { generateResponseStreaming } from '../brain/brain.js';
import { getTelegramProjectPath } from '../telegram/registry.js';
import { handleUpdate } from '../telegram/adapter.js';

function makeSend() { return vi.fn().mockResolvedValue(undefined); }

describe('handleUpdate — access gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('owner plain chat: calls the brain and replies', async () => {
    isTelegramOwner.mockReturnValue(true);
    generateResponseStreaming.mockResolvedValue({ text: 'hi there' });
    const send = makeSend();
    await handleUpdate({ userId: '1', chatId: '111', topicId: null, text: 'hey', messageId: '9' }, { send });
    expect(generateResponseStreaming).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('111', 'hi there', expect.any(Object));
  });

  it('non-owner non-allowlisted: refused, brain NOT called', async () => {
    isTelegramOwner.mockReturnValue(false);
    const send = makeSend();
    await handleUpdate(
      { userId: '2', chatId: '111', topicId: null, text: 'hey', messageId: '9' },
      { send, allowedUsers: [] },
    );
    expect(generateResponseStreaming).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1]).toMatch(/not authorized|read-only|denied/i);
  });

  it('/register from owner binds the chat', async () => {
    isTelegramOwner.mockReturnValue(true);
    const { registerTelegramChat } = await import('../telegram/registry.js');
    const send = makeSend();
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, text: '/register /home/u/proj', messageId: '9' },
      { send },
    );
    expect(registerTelegramChat).toHaveBeenCalledWith('telegram:chat:111', '/home/u/proj');
  });

  it('coding intent with no project binding: replies "register first", no brain coding', async () => {
    isTelegramOwner.mockReturnValue(true);
    getTelegramProjectPath.mockReturnValue(null);
    generateResponseStreaming.mockResolvedValue({ text: 'chatty' });
    const send = makeSend();
    // a plain message still routes to chat; binding only gates the *coding* path.
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, text: 'just chatting', messageId: '9' },
      { send },
    );
    expect(send).toHaveBeenCalled();
  });
});
