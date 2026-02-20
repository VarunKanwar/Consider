/**
 * TypeScript store adapter for the extension.
 * Re-implements the store read/write logic from shared/store.js in TypeScript.
 * Both implementations must stay in sync (same JSON schema, same atomic write pattern).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const STORE_VERSION = 1;
export const STORE_DIR_NAME = '.consider';
export const LEGACY_STORE_DIR_NAME = '.feedback';

// --- Data model types ---

export interface Anchor {
  startLine: number;
  endLine: number;
  contextBefore?: string[];
  contextAfter?: string[];
  targetContent?: string;
  contentHash?: string;
  lastAnchorCheck?: string;
}

export interface Reply {
  id: string;
  author: 'human' | 'agent';
  body: string;
  createdAt: string;
}

export type WorkflowState = 'open' | 'resolved';
export type AnchorState = 'anchored' | 'stale' | 'orphaned';
export type CommentStatus = 'open' | 'resolved' | 'stale' | 'orphaned';

export interface FeedbackComment {
  id: string;
  file: string;
  anchor: Anchor;
  workflowState: WorkflowState;
  anchorState: AnchorState;
  createdAt: string;
  author: 'human' | 'agent';
  body: string;
  thread: Reply[];
  agentLastSeenAt?: string;
}

export interface FeedbackStore {
  version: number;
  comments: FeedbackComment[];
}

interface LegacyFeedbackComment {
  id?: unknown;
  file?: unknown;
  anchor?: Partial<Anchor>;
  status?: unknown;
  workflowState?: unknown;
  anchorState?: unknown;
  createdAt?: unknown;
  author?: unknown;
  body?: unknown;
  thread?: unknown;
  agentLastSeenAt?: unknown;
}

const VALID_WORKFLOW_STATES = new Set<WorkflowState>(['open', 'resolved']);
const VALID_ANCHOR_STATES = new Set<AnchorState>(['anchored', 'stale', 'orphaned']);

function isWorkflowState(value: unknown): value is WorkflowState {
  return typeof value === 'string' && VALID_WORKFLOW_STATES.has(value as WorkflowState);
}

function isAnchorState(value: unknown): value is AnchorState {
  return typeof value === 'string' && VALID_ANCHOR_STATES.has(value as AnchorState);
}

function statesFromLegacyStatus(
  status: unknown
): { workflowState: WorkflowState; anchorState: AnchorState } | undefined {
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
  return undefined;
}

function normalizeReply(raw: unknown, index: number): Reply {
  const reply = (raw && typeof raw === 'object' ? raw : {}) as {
    id?: unknown;
    author?: unknown;
    body?: unknown;
    createdAt?: unknown;
  };

  return {
    id:
      typeof reply.id === 'string' && reply.id.length > 0
        ? reply.id
        : `r_legacy_${index}`,
    author: reply.author === 'agent' ? 'agent' : 'human',
    body: typeof reply.body === 'string' ? reply.body : '',
    createdAt:
      typeof reply.createdAt === 'string' && reply.createdAt.length > 0
        ? reply.createdAt
        : new Date(0).toISOString(),
  };
}

function normalizeComment(raw: LegacyFeedbackComment, index: number): FeedbackComment {
  const legacyStates = statesFromLegacyStatus(raw.status);
  const workflowState = isWorkflowState(raw.workflowState)
    ? raw.workflowState
    : legacyStates?.workflowState ?? 'open';
  const anchorState = isAnchorState(raw.anchorState)
    ? raw.anchorState
    : legacyStates?.anchorState ?? 'anchored';

  const anchorRaw = raw.anchor || {};
  const startLine =
    typeof anchorRaw.startLine === 'number' && anchorRaw.startLine >= 1
      ? Math.floor(anchorRaw.startLine)
      : 1;
  const endLine =
    typeof anchorRaw.endLine === 'number' && anchorRaw.endLine >= startLine
      ? Math.floor(anchorRaw.endLine)
      : startLine;

  const threadRaw = Array.isArray(raw.thread) ? raw.thread : [];
  const thread = threadRaw.map((entry, threadIndex) => normalizeReply(entry, threadIndex));

  return {
    id:
      typeof raw.id === 'string' && raw.id.length > 0
        ? raw.id
        : `c_legacy_${index}`,
    file: typeof raw.file === 'string' ? raw.file.replace(/\\/g, '/') : '',
    anchor: {
      startLine,
      endLine,
      contextBefore: Array.isArray(anchorRaw.contextBefore)
        ? anchorRaw.contextBefore.filter((line): line is string => typeof line === 'string')
        : undefined,
      contextAfter: Array.isArray(anchorRaw.contextAfter)
        ? anchorRaw.contextAfter.filter((line): line is string => typeof line === 'string')
        : undefined,
      targetContent:
        typeof anchorRaw.targetContent === 'string' ? anchorRaw.targetContent : undefined,
      contentHash: typeof anchorRaw.contentHash === 'string' ? anchorRaw.contentHash : undefined,
      lastAnchorCheck:
        typeof anchorRaw.lastAnchorCheck === 'string' ? anchorRaw.lastAnchorCheck : undefined,
    },
    workflowState,
    anchorState,
    createdAt:
      typeof raw.createdAt === 'string' && raw.createdAt.length > 0
        ? raw.createdAt
        : new Date(0).toISOString(),
    author: raw.author === 'agent' ? 'agent' : 'human',
    body: typeof raw.body === 'string' ? raw.body : '',
    thread,
    agentLastSeenAt:
      typeof raw.agentLastSeenAt === 'string' && raw.agentLastSeenAt.length > 0
        ? raw.agentLastSeenAt
        : undefined,
  };
}

function normalizeStore(data: FeedbackStore): FeedbackStore {
  const commentsRaw = Array.isArray((data as { comments?: unknown }).comments)
    ? ((data as { comments: unknown[] }).comments as LegacyFeedbackComment[])
    : [];
  return {
    version: STORE_VERSION,
    comments: commentsRaw.map((comment, index) => normalizeComment(comment, index)),
  };
}

// --- Store operations ---

export function resolveStoreDirectoryName(projectRoot: string): string {
  if (fs.existsSync(path.join(projectRoot, STORE_DIR_NAME))) {
    return STORE_DIR_NAME;
  }
  if (fs.existsSync(path.join(projectRoot, LEGACY_STORE_DIR_NAME))) {
    return LEGACY_STORE_DIR_NAME;
  }
  return STORE_DIR_NAME;
}

export function storeDirectoryPath(projectRoot: string): string {
  return path.join(projectRoot, resolveStoreDirectoryName(projectRoot));
}

export function storePath(projectRoot: string): string {
  return path.join(storeDirectoryPath(projectRoot), 'store.json');
}

export function emptyStore(): FeedbackStore {
  return { version: STORE_VERSION, comments: [] };
}

export function readStore(projectRoot: string): FeedbackStore {
  const p = storePath(projectRoot);
  if (!fs.existsSync(p)) {
    return emptyStore();
  }
  const raw = fs.readFileSync(p, 'utf-8');
  const data = JSON.parse(raw) as FeedbackStore;
  if (data.version !== STORE_VERSION) {
    throw new Error(`Unsupported store version: ${data.version} (expected ${STORE_VERSION})`);
  }
  return normalizeStore(data);
}

export function writeStore(projectRoot: string, store: FeedbackStore): void {
  const p = storePath(projectRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const normalizedStore = normalizeStore(store);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalizedStore, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, p);
}

export function generateCommentId(): string {
  return 'c_' + crypto.randomBytes(4).toString('hex');
}

export function generateReplyId(): string {
  return 'r_' + crypto.randomBytes(4).toString('hex');
}

export function findComment(store: FeedbackStore, commentId: string): FeedbackComment | undefined {
  return store.comments.find(c => c.id === commentId);
}

/**
 * Get comments for a specific file path (relative to project root).
 */
export function getCommentsForFile(store: FeedbackStore, filePath: string): FeedbackComment[] {
  return store.comments.filter(c => c.file === filePath);
}

export function getCommentStatus(comment: FeedbackComment): CommentStatus {
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

function latestHumanMessageAtMs(comment: FeedbackComment): number | null {
  let latestMs: number | null = null;

  if (comment.author === 'human') {
    const createdMs = Date.parse(comment.createdAt);
    if (Number.isFinite(createdMs)) {
      latestMs = createdMs;
    }
  }

  for (const reply of comment.thread) {
    if (reply.author !== 'human') {
      continue;
    }
    const replyMs = Date.parse(reply.createdAt);
    if (!Number.isFinite(replyMs)) {
      continue;
    }
    if (latestMs === null || replyMs > latestMs) {
      latestMs = replyMs;
    }
  }

  return latestMs;
}

export function hasUnseenHumanActivity(comment: FeedbackComment): boolean {
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
