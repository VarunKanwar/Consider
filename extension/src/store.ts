/**
 * TypeScript store adapter for the extension.
 * Delegates persistence semantics to the shared runtime store module so the
 * extension and CLI use identical locking/write/conflict behavior.
 */

import * as path from 'path';

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

export interface MutateStoreResult<TResult> {
  store: FeedbackStore;
  result: TResult | false;
}

type SharedStoreModule = {
  STORE_VERSION: number;
  resolveStoreDirectoryName: (projectRoot: string) => string;
  storePath: (projectRoot: string) => string;
  emptyStore: () => FeedbackStore;
  readStore: (projectRoot: string) => FeedbackStore;
  writeStore: (projectRoot: string, store: FeedbackStore) => void;
  mutateStore: (
    projectRoot: string,
    mutator: (store: FeedbackStore) => unknown
  ) => { store: FeedbackStore; result: unknown };
  generateCommentId: () => string;
  generateReplyId: () => string;
  findComment: (store: FeedbackStore, commentId: string) => FeedbackComment | null;
  getCommentStatus: (comment: FeedbackComment) => CommentStatus;
  hasUnseenHumanActivity: (comment: FeedbackComment) => boolean;
  markAgentSeen: (comment: FeedbackComment, nowIso?: string) => boolean;
};

const sharedStore = require('../runtime/shared/store.js') as SharedStoreModule;
export const STORE_VERSION = sharedStore.STORE_VERSION;

// --- Store operations ---

export function resolveStoreDirectoryName(projectRoot: string): string {
  return sharedStore.resolveStoreDirectoryName(projectRoot);
}

export function storeDirectoryPath(projectRoot: string): string {
  return path.join(projectRoot, resolveStoreDirectoryName(projectRoot));
}

export function storePath(projectRoot: string): string {
  return sharedStore.storePath(projectRoot);
}

export function emptyStore(): FeedbackStore {
  return sharedStore.emptyStore();
}

export function readStore(projectRoot: string): FeedbackStore {
  return sharedStore.readStore(projectRoot);
}

export function writeStore(projectRoot: string, store: FeedbackStore): void {
  sharedStore.writeStore(projectRoot, store);
}

export function mutateStore<TResult>(
  projectRoot: string,
  mutator: (store: FeedbackStore) => TResult | false
): MutateStoreResult<TResult> {
  return sharedStore.mutateStore(projectRoot, mutator) as MutateStoreResult<TResult>;
}

export function generateCommentId(): string {
  return sharedStore.generateCommentId();
}

export function generateReplyId(): string {
  return sharedStore.generateReplyId();
}

export function findComment(
  store: FeedbackStore,
  commentId: string
): FeedbackComment | undefined {
  const found = sharedStore.findComment(store, commentId);
  return found === null ? undefined : found;
}

/**
 * Get comments for a specific file path (relative to project root).
 */
export function getCommentsForFile(
  store: FeedbackStore,
  filePath: string
): FeedbackComment[] {
  return store.comments.filter((comment) => comment.file === filePath);
}

export function getCommentStatus(comment: FeedbackComment): CommentStatus {
  return sharedStore.getCommentStatus(comment);
}

export function hasUnseenHumanActivity(comment: FeedbackComment): boolean {
  return sharedStore.hasUnseenHumanActivity(comment);
}

export function markAgentSeen(comment: FeedbackComment, nowIso?: string): boolean {
  return sharedStore.markAgentSeen(comment, nowIso);
}
