import { FeedbackStore } from './store';

export interface ReconcileOptions {
  force?: boolean;
  files?: string[];
  nowIso?: string;
}

export interface ReconcileResult {
  changed: boolean;
  checkedComments: number;
  updatedComments: number;
  stateChanges: number;
  statusChanges: number;
}

type SharedReconcileModule = {
  reconcileStore: (
    projectRoot: string,
    feedbackStore: FeedbackStore,
    options?: ReconcileOptions
  ) => ReconcileResult;
  hashContent: (content: string) => string;
};

// Keep CLI and extension reconciliation behavior identical by delegating to the
// same shared implementation bundled with the extension package.
const sharedReconcile = require('../runtime/shared/reconcile.js') as SharedReconcileModule;

export function reconcileStoreForExtension(
  projectRoot: string,
  feedbackStore: FeedbackStore,
  options?: ReconcileOptions
): ReconcileResult {
  return sharedReconcile.reconcileStore(projectRoot, feedbackStore, options);
}

export function hashAnchorContent(content: string): string {
  return sharedReconcile.hashContent(content);
}
