/**
 * Shared reconciliation logic for content-based anchor tracking.
 * Used by both the CLI and extension to keep behavior identical.
 * Zero npm dependencies — Node builtins only.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONTEXT_WINDOW = 2;
const FUZZY_THRESHOLD_WITH_CONTEXT = 0.55;
const FUZZY_THRESHOLD_NO_CONTEXT = 0.72;
const AMBIGUITY_DELTA = 0.03;

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function hashContent(content) {
  return crypto.createHash('sha1').update(content || '').digest('hex').slice(0, 8);
}

function parseIsoToMs(value) {
  if (!value) return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function getFileInfo(projectRoot, fileRelativePath, cache) {
  const normalized = normalizePath(fileRelativePath);
  if (cache.has(normalized)) {
    return cache.get(normalized);
  }

  const filePath = path.join(projectRoot, normalized);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      const nonFileInfo = { exists: false, mtimeMs: 0, content: '', lines: [] };
      cache.set(normalized, nonFileInfo);
      return nonFileInfo;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const content = raw.replace(/\r\n/g, '\n');
    const lines = content.split('\n');
    const info = { exists: true, mtimeMs: stat.mtimeMs, content, lines };
    cache.set(normalized, info);
    return info;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      const missingInfo = { exists: false, mtimeMs: 0, content: '', lines: [] };
      cache.set(normalized, missingInfo);
      return missingInfo;
    }
    throw error;
  }
}

function getTargetLineCount(anchor) {
  const targetContent = typeof anchor.targetContent === 'string' ? anchor.targetContent : '';
  if (targetContent.length > 0) {
    return Math.max(1, targetContent.split('\n').length);
  }
  const span = (anchor.endLine || 1) - (anchor.startLine || 1) + 1;
  return Math.max(1, span);
}

function getSlice(lines, startLine, endLine) {
  const startIdx = Math.max(0, startLine - 1);
  const endIdx = Math.max(startIdx, endLine);
  return lines.slice(startIdx, endIdx).join('\n');
}

function findUniqueExactMatch(content, targetContent) {
  if (!targetContent || targetContent.length === 0) {
    return null;
  }

  let firstIndex = -1;
  let count = 0;
  let searchFrom = 0;
  while (searchFrom <= content.length) {
    const index = content.indexOf(targetContent, searchFrom);
    if (index === -1) break;
    count += 1;
    if (count === 1) {
      firstIndex = index;
    } else {
      return null;
    }
    searchFrom = index + 1;
  }

  if (count !== 1) {
    return null;
  }
  return firstIndex;
}

function indexToLineNumber(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function tokenSet(text) {
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g);
  return new Set(tokens || []);
}

function scoreTextSimilarity(left, right) {
  const a = (left || '').trim();
  const b = (right || '').trim();
  if (a === b) {
    return 1;
  }
  if (a.length === 0 && b.length === 0) {
    return 1;
  }

  const leftTokens = tokenSet(a);
  const rightTokens = tokenSet(b);

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;

  const maxLen = Math.max(a.length, b.length);
  const lengthScore = maxLen === 0 ? 1 : 1 - Math.min(1, Math.abs(a.length - b.length) / maxLen);

  return (jaccard * 0.7) + (lengthScore * 0.3);
}

function scoreContext(lines, startLine, targetLineCount, contextBefore, contextAfter) {
  let matched = 0;
  let total = 0;

  for (let i = 0; i < contextBefore.length; i++) {
    total += 1;
    const lineIdx = startLine - contextBefore.length + i - 1;
    if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx] === contextBefore[i]) {
      matched += 1;
    }
  }

  for (let i = 0; i < contextAfter.length; i++) {
    total += 1;
    const lineIdx = startLine + targetLineCount - 1 + i;
    if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx] === contextAfter[i]) {
      matched += 1;
    }
  }

  if (total === 0) {
    return { score: null, matched: 0, total: 0 };
  }
  return { score: matched / total, matched, total };
}

function buildAnchorSnapshot(lines, startLine, endLine, originalAnchor, nowIso) {
  const beforeWindow = Array.isArray(originalAnchor.contextBefore)
    ? originalAnchor.contextBefore.length
    : DEFAULT_CONTEXT_WINDOW;
  const afterWindow = Array.isArray(originalAnchor.contextAfter)
    ? originalAnchor.contextAfter.length
    : DEFAULT_CONTEXT_WINDOW;

  const contextBefore = lines.slice(
    Math.max(0, startLine - 1 - beforeWindow),
    Math.max(0, startLine - 1)
  );
  const contextAfter = lines.slice(
    Math.max(0, endLine),
    Math.max(0, endLine + afterWindow)
  );
  const targetContent = getSlice(lines, startLine, endLine);

  return {
    startLine,
    endLine,
    contextBefore,
    contextAfter,
    targetContent,
    contentHash: hashContent(targetContent),
    lastAnchorCheck: nowIso,
  };
}

function shouldProcessComment(comment) {
  return Boolean(comment);
}

function shouldReconcileByMtime(comment, fileInfo, force) {
  if (force) {
    return true;
  }
  if (!fileInfo.exists) {
    return true;
  }
  const lastCheckMs = parseIsoToMs(comment.anchor && comment.anchor.lastAnchorCheck);
  if (!Number.isFinite(lastCheckMs)) {
    return true;
  }
  return fileInfo.mtimeMs > lastCheckMs;
}

function reconcileCommentAnchor(comment, fileInfo, nowIso) {
  let changed = false;
  let stateChanged = false;

  if (!comment.anchor) {
    comment.anchor = { startLine: 1, endLine: 1 };
    changed = true;
  }

  if (comment.anchorState !== 'anchored' && comment.anchorState !== 'stale' && comment.anchorState !== 'orphaned') {
    comment.anchorState = 'anchored';
    changed = true;
    stateChanged = true;
  }

  if (!fileInfo.exists) {
    if (comment.anchorState !== 'orphaned') {
      comment.anchorState = 'orphaned';
      changed = true;
      stateChanged = true;
    }
    if (comment.anchor.lastAnchorCheck !== nowIso) {
      comment.anchor.lastAnchorCheck = nowIso;
      changed = true;
    }
    return { changed, stateChanged };
  }

  const startLine = comment.anchor.startLine || 1;
  const targetLineCount = getTargetLineCount(comment.anchor);
  const endLine = startLine + targetLineCount - 1;
  const storedTarget = typeof comment.anchor.targetContent === 'string'
    ? comment.anchor.targetContent
    : '';
  const currentAtStored = getSlice(fileInfo.lines, startLine, endLine);

  let resolvedStartLine = null;

  // Fast path: line and target content still match at stored position.
  if (storedTarget && currentAtStored === storedTarget) {
    resolvedStartLine = startLine;
  } else if (storedTarget) {
    // Exact content search fallback. Only accept unique matches.
    const exactIndex = findUniqueExactMatch(fileInfo.content, storedTarget);
    if (exactIndex !== null) {
      resolvedStartLine = indexToLineNumber(fileInfo.content, exactIndex);
    }
  }

  if (resolvedStartLine === null) {
    // Fuzzy context fallback using surrounding lines + target similarity + proximity.
    const contextBefore = Array.isArray(comment.anchor.contextBefore) ? comment.anchor.contextBefore : [];
    const contextAfter = Array.isArray(comment.anchor.contextAfter) ? comment.anchor.contextAfter : [];
    const hasContext = contextBefore.length + contextAfter.length > 0;

    const maxStartLine = Math.max(1, fileInfo.lines.length - targetLineCount + 1);
    let best = null;
    let secondBest = null;

    for (let candidateStart = 1; candidateStart <= maxStartLine; candidateStart++) {
      const candidateEnd = candidateStart + targetLineCount - 1;
      const candidateTarget = getSlice(fileInfo.lines, candidateStart, candidateEnd);
      const targetScore = scoreTextSimilarity(storedTarget, candidateTarget);

      const context = scoreContext(
        fileInfo.lines,
        candidateStart,
        targetLineCount,
        contextBefore,
        contextAfter
      );

      const distance = Math.abs(candidateStart - startLine);
      const proximityScore = 1 - Math.min(1, distance / 200);

      const combined = context.score === null
        ? (targetScore * 0.85) + (proximityScore * 0.15)
        : (context.score * 0.65) + (targetScore * 0.25) + (proximityScore * 0.10);

      const candidate = {
        line: candidateStart,
        score: combined,
        contextScore: context.score,
        contextMatches: context.matched,
        contextTotal: context.total,
      };

      if (!best || candidate.score > best.score) {
        secondBest = best;
        best = candidate;
      } else if (!secondBest || candidate.score > secondBest.score) {
        secondBest = candidate;
      }
    }

    if (best) {
      const threshold = hasContext
        ? FUZZY_THRESHOLD_WITH_CONTEXT
        : FUZZY_THRESHOLD_NO_CONTEXT;
      const ambiguous = secondBest
        && secondBest.score >= threshold
        && (best.score - secondBest.score) < AMBIGUITY_DELTA;
      const strongEnough = best.score >= threshold;
      const hasSignal = !hasContext || best.contextMatches > 0;

      if (strongEnough && !ambiguous && hasSignal) {
        resolvedStartLine = best.line;
      }
    }
  }

  if (resolvedStartLine === null) {
    if (comment.anchorState !== 'stale') {
      comment.anchorState = 'stale';
      changed = true;
      stateChanged = true;
    }
    if (comment.anchor.lastAnchorCheck !== nowIso) {
      comment.anchor.lastAnchorCheck = nowIso;
      changed = true;
    }
    return { changed, stateChanged };
  }

  const resolvedEndLine = resolvedStartLine + targetLineCount - 1;
  const nextAnchor = buildAnchorSnapshot(
    fileInfo.lines,
    resolvedStartLine,
    resolvedEndLine,
    comment.anchor,
    nowIso
  );

  if (comment.anchor.startLine !== nextAnchor.startLine) {
    comment.anchor.startLine = nextAnchor.startLine;
    changed = true;
  }
  if (comment.anchor.endLine !== nextAnchor.endLine) {
    comment.anchor.endLine = nextAnchor.endLine;
    changed = true;
  }
  if (JSON.stringify(comment.anchor.contextBefore || []) !== JSON.stringify(nextAnchor.contextBefore)) {
    comment.anchor.contextBefore = nextAnchor.contextBefore;
    changed = true;
  }
  if (JSON.stringify(comment.anchor.contextAfter || []) !== JSON.stringify(nextAnchor.contextAfter)) {
    comment.anchor.contextAfter = nextAnchor.contextAfter;
    changed = true;
  }
  if ((comment.anchor.targetContent || '') !== nextAnchor.targetContent) {
    comment.anchor.targetContent = nextAnchor.targetContent;
    changed = true;
  }
  if ((comment.anchor.contentHash || '') !== nextAnchor.contentHash) {
    comment.anchor.contentHash = nextAnchor.contentHash;
    changed = true;
  }
  if (comment.anchor.lastAnchorCheck !== nextAnchor.lastAnchorCheck) {
    comment.anchor.lastAnchorCheck = nextAnchor.lastAnchorCheck;
    changed = true;
  }

  if (comment.anchorState !== 'anchored') {
    comment.anchorState = 'anchored';
    changed = true;
    stateChanged = true;
  }

  return { changed, stateChanged };
}

/**
 * Reconcile anchors in-place for comments in a store.
 *
 * Options:
 *  - force: reconcile regardless of mtime for matching comments
 *  - files: optional array of relative file paths to restrict reconciliation
 */
function reconcileStore(projectRoot, feedbackStore, options = {}) {
  const force = Boolean(options.force);
  const fileFilter = Array.isArray(options.files) && options.files.length > 0
    ? new Set(options.files.map(normalizePath))
    : null;
  const nowIso = typeof options.nowIso === 'string'
    ? options.nowIso
    : new Date().toISOString();

  const fileCache = new Map();
  let checkedComments = 0;
  let updatedComments = 0;
  let stateChanges = 0;

  for (const comment of feedbackStore.comments) {
    if (!shouldProcessComment(comment)) {
      continue;
    }
    const normalizedFile = normalizePath(comment.file);
    if (fileFilter && !fileFilter.has(normalizedFile)) {
      continue;
    }

    const fileInfo = getFileInfo(projectRoot, normalizedFile, fileCache);
    if (!shouldReconcileByMtime(comment, fileInfo, force)) {
      continue;
    }

    checkedComments += 1;
    const result = reconcileCommentAnchor(comment, fileInfo, nowIso);
    if (result.changed) {
      updatedComments += 1;
    }
    if (result.stateChanged) {
      stateChanges += 1;
    }
  }

  return {
    changed: updatedComments > 0,
    checkedComments,
    updatedComments,
    stateChanges,
    statusChanges: stateChanges,
  };
}

module.exports = {
  reconcileStore,
  hashContent,
};
