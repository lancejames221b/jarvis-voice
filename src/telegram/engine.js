import fs from 'fs';
import logger from '../logger.js';

const VALID_ENGINES = new Set(['claude', 'qwen']);

function getStorePath() {
  return process.env.TELEGRAM_ENGINE_STORE
    || `${process.env.HOME || '/tmp'}/.local/state/jarvis-voice/telegram-engine.json`;
}

function readStore() {
  const storePath = getStorePath();
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    if (!raw || !raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT' || !err.code) {
      return {};
    }
    logger.warn(`telegram/engine: failed to read store at ${storePath}: ${err.message}`);
    return {};
  }
}

function writeStore(store) {
  const storePath = getStorePath();
  const dir = storePath.substring(0, storePath.lastIndexOf('/'));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // directory may already exist
  }
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

export function getEngine(chatKey) {
  const store = readStore();
  return store[chatKey] || 'claude';
}

export function setEngine(chatKey, engine) {
  if (!VALID_ENGINES.has(engine)) {
    throw new Error(`Invalid engine "${engine}": must be "claude" or "qwen"`);
  }
  const store = readStore();
  store[chatKey] = engine;
  writeStore(store);
}

export function resolveEngineEnv(engine) {
  if (engine === 'claude') {
    return {};
  }

  // Set JARVIS_LMS_BASE_URL to the LM Studio host serving the local model.
  // Default is a placeholder hostname; the real LAN address is supplied via env.
  const baseUrl = process.env.JARVIS_LMS_BASE_URL || 'http://lmstudio.local:1234';
  const model = process.env.JARVIS_LMS_MODEL || 'qwen/qwen3.6-35b-a3b';

  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'lmstudio',
    model,
  };
}
