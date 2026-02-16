/**
 * Shared store logic for reading/writing .feedback/store.json.
 * Used by both the CLI and (eventually) the extension.
 * Zero npm dependencies — Node builtins only.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_VERSION = 1;

/**
 * Find the project root by walking up from startDir looking for .feedback/.
 * Falls back to startDir itself if not found.
 */
function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, '.feedback'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return path.resolve(startDir);
}

function storePath(projectRoot) {
  return path.join(projectRoot, '.feedback', 'store.json');
}

function emptyStore() {
  return { version: STORE_VERSION, comments: [] };
}

/**
 * Read the store. Returns an empty store if the file doesn't exist.
 */
function readStore(projectRoot) {
  const p = storePath(projectRoot);
  if (!fs.existsSync(p)) {
    return emptyStore();
  }
  const raw = fs.readFileSync(p, 'utf-8');
  const data = JSON.parse(raw);
  if (data.version !== STORE_VERSION) {
    throw new Error(`Unsupported store version: ${data.version} (expected ${STORE_VERSION})`);
  }
  return data;
}

/**
 * Write the store atomically (write to temp file, then rename).
 */
function writeStore(projectRoot, store) {
  const p = storePath(projectRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, p);
}

/**
 * Generate a comment ID (c_ prefix + 8 hex chars).
 */
function generateCommentId() {
  return 'c_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Generate a reply ID (r_ prefix + 8 hex chars).
 */
function generateReplyId() {
  return 'r_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Find a comment by ID. Returns null if not found.
 */
function findComment(store, commentId) {
  return store.comments.find(c => c.id === commentId) || null;
}

module.exports = {
  STORE_VERSION,
  findProjectRoot,
  storePath,
  emptyStore,
  readStore,
  writeStore,
  generateCommentId,
  generateReplyId,
  findComment,
};
