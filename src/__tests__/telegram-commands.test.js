import { describe, it, expect } from 'vitest';
import { parseCommand } from '../telegram/commands.js';

describe('parseCommand', () => {
  it('returns null for a plain message', () => {
    expect(parseCommand('build the login form')).toBeNull();
  });
  it('parses /register with a path arg', () => {
    expect(parseCommand('/register /home/u/proj')).toEqual({ cmd: 'register', arg: '/home/u/proj' });
  });
  it('parses /engine with an engine arg', () => {
    expect(parseCommand('/engine qwen')).toEqual({ cmd: 'engine', arg: 'qwen' });
  });
  it('parses /model with a model arg', () => {
    expect(parseCommand('/model claude-opus-4-7')).toEqual({ cmd: 'model', arg: 'claude-opus-4-7' });
  });
  it('parses /status with no arg', () => {
    expect(parseCommand('/status')).toEqual({ cmd: 'status', arg: null });
  });
  it('parses /cancel with no arg', () => {
    expect(parseCommand('/cancel')).toEqual({ cmd: 'cancel', arg: null });
  });
  it('parses /verbose on/off', () => {
    expect(parseCommand('/verbose on')).toEqual({ cmd: 'verbose', arg: 'on' });
    expect(parseCommand('/verbose off')).toEqual({ cmd: 'verbose', arg: 'off' });
  });
  it('strips a bot @mention suffix Telegram adds in groups', () => {
    expect(parseCommand('/status@my_bot')).toEqual({ cmd: 'status', arg: null });
  });
  it('returns an unknown marker for an unrecognized slash command', () => {
    expect(parseCommand('/frobnicate x')).toEqual({ cmd: 'unknown', arg: 'frobnicate' });
  });
});
