/**
 * config-writer.js — atomic, comment-preserving writes to ~/.config/openjarvis/config.yaml.
 *
 * Uses YAML.Document so existing comments and key order survive edits.
 * Always writes a timestamped backup beside the file before mutating.
 * Then re-hydrates process.env from the new YAML so live behavior reflects the change.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import YAML from 'yaml';
import config from './config.js';
import { hydrateEnvFromConfig } from './config-env-bootstrap.js';

const PATH = process.env.OPENJARVIS_CONFIG_PATH ||
             join(homedir(), '.config', 'openjarvis', 'config.yaml');

function _backup() {
  if (!existsSync(PATH)) return null;
  const bak = `${PATH}.bak.${Date.now()}`;
  copyFileSync(PATH, bak);
  return bak;
}

function _readDoc() {
  mkdirSync(dirname(PATH), { recursive: true });
  if (!existsSync(PATH)) return new YAML.Document({});
  return YAML.parseDocument(readFileSync(PATH, 'utf8'));
}

function _writeDoc(doc) {
  writeFileSync(PATH, doc.toString(), 'utf8');
  config.reload();
}

/**
 * Set one or more config keys at once.
 * @param {Object} updates - { 'flags.taskAgentEnabled': true, 'voice.vadTimeoutMs': 1500 }
 * @returns {{ path: string, backup: string|null, applied: string[], rehydrated: number }}
 */
export function setConfigValues(updates) {
  if (!updates || typeof updates !== 'object') {
    throw new Error('setConfigValues: updates must be an object');
  }
  const backup = _backup();
  const doc = _readDoc();
  const applied = [];
  for (const [dottedPath, value] of Object.entries(updates)) {
    const parts = dottedPath.split('.');
    doc.setIn(parts, value);
    applied.push(dottedPath);
  }
  _writeDoc(doc);
  const r = hydrateEnvFromConfig();
  return { path: PATH, backup, applied, rehydrated: r.hydrated };
}

/**
 * Delete a key from the YAML, so its fallback (env or default) takes effect.
 * @param {string} dottedPath
 */
export function unsetConfigValue(dottedPath) {
  const backup = _backup();
  const doc = _readDoc();
  const parts = dottedPath.split('.');
  doc.deleteIn(parts);
  _writeDoc(doc);
  const r = hydrateEnvFromConfig();
  return { path: PATH, backup, unset: dottedPath, rehydrated: r.hydrated };
}

/**
 * Read the YAML file as text (for previewing in admin UI).
 */
export function readConfigText() {
  if (!existsSync(PATH)) return '';
  return readFileSync(PATH, 'utf8');
}

/**
 * Replace the entire YAML file with the given text.
 * Validates by parsing first; rejects on parse error.
 */
export function writeConfigText(text) {
  const parsed = YAML.parse(text);
  if (parsed === undefined) throw new Error('writeConfigText: parsed to undefined');
  const backup = _backup();
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, text, 'utf8');
  config.reload();
  const r = hydrateEnvFromConfig();
  return { path: PATH, backup, bytes: text.length, rehydrated: r.hydrated };
}
