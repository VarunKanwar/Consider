/**
 * Shared store logic for reading/writing .feedback/store.json.
 * Used by both the CLI and extension.
 * Zero npm dependencies — Node builtins only.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_VERSION = 1;
const STORE_LOCK_TIMEOUT_MS = 5000;
const STORE_LOCK_RETRY_MS = 25;
const STORE_LOCK_STALE_MS = 30000;
const STORE_REVISION_KEY = '__feedbackStoreRevision';
const VALID_WORKFLOW_STATES = new Set(['open', 'resolved']);
const VALID_ANCHOR_STATES = new Set(['anchored', 'stale', 'orphaned']);

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

function lockPath(projectRoot) {
  return storePath(projectRoot) + '.lock';
}

function emptyStore() {
  return { version: STORE_VERSION, comments: [] };
}

function hashStoreRaw(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function attachStoreRevision(data, revision) {
  if (!data || typeof data !== 'object') {
    return data;
  }
  Object.defineProperty(data, STORE_REVISION_KEY, {
    value: revision,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return data;
}

function getStoreRevision(data) {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  return data[STORE_REVISION_KEY];
}

function sleepMs(ms) {
  if (ms <= 0) {
    return;
  }
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitArray, 0, 0, ms);
}

function statesFromLegacyStatus(status) {
  if (status === 'resolved') {
    return { workflowState: 'resolved', anchorState: 'anchored' };
  }
  if (status === 'stale') {
    return { workflowState: 'open', anchorState: 'stale' };
  }
  if (status === 'orphaned') {
    return { workflowState: 'open', anchorState: 'orphaned' };
  }
  if (status === 'open') {
    return { workflowState: 'open', anchorState: 'anchored' };
  }
  return null;
}

function normalizeReply(reply, index) {
  const value = reply && typeof reply === 'object' ? reply : {};
  return {
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : `r_legacy_${index}`,
    author: value.author === 'agent' ? 'agent' : 'human',
    body: typeof value.body === 'string' ? value.body : '',
    createdAt:
      typeof value.createdAt === 'string' && value.createdAt.length > 0
        ? value.createdAt
        : new Date(0).toISOString(),
  };
}

function normalizeComment(comment, index) {
  const value = comment && typeof comment === 'object' ? comment : {};
  const legacyStates = statesFromLegacyStatus(value.status);

  const workflowState = VALID_WORKFLOW_STATES.has(value.workflowState)
    ? value.workflowState
    : legacyStates
      ? legacyStates.workflowState
      : 'open';
  const anchorState = VALID_ANCHOR_STATES.has(value.anchorState)
    ? value.anchorState
    : legacyStates
      ? legacyStates.anchorState
      : 'anchored';

  const anchor = value.anchor && typeof value.anchor === 'object' ? value.anchor : {};
  const startLine =
    typeof anchor.startLine === 'number' && anchor.startLine >= 1
      ? Math.floor(anchor.startLine)
      : 1;
  const endLine =
    typeof anchor.endLine === 'number' && anchor.endLine >= startLine
      ? Math.floor(anchor.endLine)
      : startLine;

  const thread = Array.isArray(value.thread)
    ? value.thread.map((entry, threadIndex) => normalizeReply(entry, threadIndex))
    : [];

  const normalized = {
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : `c_legacy_${index}`,
    file: typeof value.file === 'string' ? value.file.replace(/\\/g, '/') : '',
    anchor: {
      startLine,
      endLine,
      contextBefore: Array.isArray(anchor.contextBefore)
        ? anchor.contextBefore.filter((line) => typeof line === 'string')
        : undefined,
      contextAfter: Array.isArray(anchor.contextAfter)
        ? anchor.contextAfter.filter((line) => typeof line === 'string')
        : undefined,
      targetContent: typeof anchor.targetContent === 'string' ? anchor.targetContent : undefined,
      contentHash: typeof anchor.contentHash === 'string' ? anchor.contentHash : undefined,
      lastAnchorCheck:
        typeof anchor.lastAnchorCheck === 'string' ? anchor.lastAnchorCheck : undefined,
    },
    workflowState,
    anchorState,
    createdAt:
      typeof value.createdAt === 'string' && value.createdAt.length > 0
        ? value.createdAt
        : new Date(0).toISOString(),
    author: value.author === 'agent' ? 'agent' : 'human',
    body: typeof value.body === 'string' ? value.body : '',
    thread,
  };

  if (typeof value.agentLastSeenAt === 'string' && value.agentLastSeenAt.length > 0) {
    normalized.agentLastSeenAt = value.agentLastSeenAt;
  }

  return normalized;
}

function normalizeStoreData(data) {
  const comments = Array.isArray(data && data.comments)
    ? data.comments.map((comment, index) => normalizeComment(comment, index))
    : [];
  return {
    version: STORE_VERSION,
    comments,
  };
}

function readStoreInternal(projectRoot) {
  const p = storePath(projectRoot);
  if (!fs.existsSync(p)) {
    return {
      data: emptyStore(),
      revision: 'missing',
      raw: null,
    };
  }

  const raw = fs.readFileSync(p, 'utf-8');
  const parsed = JSON.parse(raw);
  if (parsed.version !== STORE_VERSION) {
    throw new Error(`Unsupported store version: ${parsed.version} (expected ${STORE_VERSION})`);
  }

  return {
    data: normalizeStoreData(parsed),
    revision: hashStoreRaw(raw),
    raw,
  };
}

function acquireStoreLock(projectRoot, options = {}) {
  const p = storePath(projectRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const lock = lockPath(projectRoot);
  const timeoutMs = options.timeoutMs || STORE_LOCK_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs || STORE_LOCK_RETRY_MS;
  const staleMs = options.staleMs || STORE_LOCK_STALE_MS;
  const startedAt = Date.now();

  while (true) {
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n',
          'utf-8'
        );
      } catch {
        // Lock metadata is best-effort only.
      }
      return () => {
        try {
          fs.closeSync(fd);
        } catch {
          // noop
        }
        try {
          fs.unlinkSync(lock);
        } catch (err) {
          if (err && err.code !== 'ENOENT') {
            throw err;
          }
        }
      };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw err;
      }

      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > staleMs) {
          try {
            fs.unlinkSync(lock);
            continue;
          } catch (unlinkErr) {
            if (!unlinkErr || unlinkErr.code !== 'ENOENT') {
              // Another process may have replaced the lock between stat/unlink.
            }
          }
        }
      } catch (statErr) {
        if (!statErr || statErr.code !== 'ENOENT') {
          // Ignore transient stat errors and continue retrying.
        }
      }

      if (Date.now() - startedAt >= timeoutMs) {
        const timeoutErr = new Error(
          `Timed out waiting for feedback store lock after ${timeoutMs}ms.`
        );
        timeoutErr.code = 'ESTORELOCKTIMEOUT';
        throw timeoutErr;
      }

      sleepMs(retryDelayMs);
    }
  }
}

function writeStoreLocked(projectRoot, store, options = {}) {
  const p = storePath(projectRoot);
  const current = readStoreInternal(projectRoot);
  const expectedRevision = getStoreRevision(store);
  const allowConflict = options.allowConflict === true;

  if (
    expectedRevision !== undefined &&
    expectedRevision !== null &&
    expectedRevision !== current.revision &&
    !allowConflict
  ) {
    const conflictError = new Error(
      'Feedback store changed since it was read. Retry with fresh state.'
    );
    conflictError.code = 'ESTORECONFLICT';
    throw conflictError;
  }

  const normalizedStore = normalizeStoreData(store);
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const raw = JSON.stringify(normalizedStore, null, 2) + '\n';
  fs.writeFileSync(tmp, raw, 'utf-8');
  fs.renameSync(tmp, p);

  store.version = STORE_VERSION;
  store.comments = normalizedStore.comments;
  if (store[STORE_REVISION_KEY] !== undefined) {
    delete store[STORE_REVISION_KEY];
  }
  attachStoreRevision(store, hashStoreRaw(raw));
}

/**
 * Read the store. Returns an empty store if the file doesn't exist.
 */
function readStore(projectRoot) {
  const { data, revision } = readStoreInternal(projectRoot);
  return attachStoreRevision(data, revision);
}

/**
 * Write the store atomically (write to temp file, then rename).
 */
function writeStore(projectRoot, store) {
  const release = acquireStoreLock(projectRoot);
  try {
    writeStoreLocked(projectRoot, store);
  } finally {
    release();
  }
}

/**
 * Mutate the latest on-disk store under a process lock and write atomically.
 * If mutator returns false, no write occurs.
 */
function mutateStore(projectRoot, mutator) {
  if (typeof mutator !== 'function') {
    throw new Error('mutateStore requires a mutator function.');
  }

  const release = acquireStoreLock(projectRoot);
  try {
    const current = readStore(projectRoot);
    const result = mutator(current);
    if (result !== false) {
      writeStoreLocked(projectRoot, current, { allowConflict: true });
    }
    return {
      store: current,
      result,
    };
  } finally {
    release();
  }
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
  return store.comments.find((c) => c.id === commentId) || null;
}

function getCommentStatus(comment) {
  if (comment.workflowState === 'resolved') {
    return 'resolved';
  }
  if (comment.anchorState === 'stale') {
    return 'stale';
  }
  if (comment.anchorState === 'orphaned') {
    return 'orphaned';
  }
  return 'open';
}

function latestHumanMessageAtMs(comment) {
  let latestMs = Number.NaN;

  if (comment.author === 'human') {
    const rootMs = Date.parse(comment.createdAt || '');
    if (Number.isFinite(rootMs)) {
      latestMs = rootMs;
    }
  }

  if (Array.isArray(comment.thread)) {
    for (const reply of comment.thread) {
      if (!reply || reply.author !== 'human') {
        continue;
      }
      const replyMs = Date.parse(reply.createdAt || '');
      if (!Number.isFinite(replyMs)) {
        continue;
      }
      if (!Number.isFinite(latestMs) || replyMs > latestMs) {
        latestMs = replyMs;
      }
    }
  }

  return Number.isFinite(latestMs) ? latestMs : null;
}

function hasUnseenHumanActivity(comment) {
  const latestHumanMs = latestHumanMessageAtMs(comment);
  if (latestHumanMs === null) {
    return false;
  }
  const seenMs = Date.parse(comment.agentLastSeenAt || '');
  if (!Number.isFinite(seenMs)) {
    return true;
  }
  return latestHumanMs > seenMs;
}

function markAgentSeen(comment, nowIso) {
  const value = typeof nowIso === 'string' && nowIso.length > 0
    ? nowIso
    : new Date().toISOString();
  if (comment.agentLastSeenAt !== value) {
    comment.agentLastSeenAt = value;
    return true;
  }
  return false;
}

module.exports = {
  STORE_VERSION,
  findProjectRoot,
  storePath,
  emptyStore,
  readStore,
  writeStore,
  mutateStore,
  generateCommentId,
  generateReplyId,
  findComment,
  getCommentStatus,
  hasUnseenHumanActivity,
  markAgentSeen,
};
