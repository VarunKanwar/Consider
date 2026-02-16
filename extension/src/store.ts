/**
 * TypeScript store adapter for the extension.
 * Re-implements the store read/write logic from shared/store.js in TypeScript.
 * Both implementations must stay in sync (same JSON schema, same atomic write pattern).
 *
 * Phase 2: static line numbers, no reconciliation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export const STORE_VERSION = 1;

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

export type CommentStatus = 'open' | 'resolved' | 'stale' | 'orphaned';

export interface FeedbackComment {
  id: string;
  file: string;
  anchor: Anchor;
  status: CommentStatus;
  createdAt: string;
  author: 'human' | 'agent';
  body: string;
  thread: Reply[];
}

export interface FeedbackStore {
  version: number;
  comments: FeedbackComment[];
}

// --- Store operations ---

export function storePath(projectRoot: string): string {
  return path.join(projectRoot, '.feedback', 'store.json');
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
  // Ensure all comments have a thread array
  for (const c of data.comments) {
    if (!c.thread) {
      c.thread = [];
    }
  }
  return data;
}

export function writeStore(projectRoot: string, store: FeedbackStore): void {
  const p = storePath(projectRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf-8');
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
