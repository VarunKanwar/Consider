import * as fs from 'fs';
import * as path from 'path';
import { FeedbackComment, FeedbackStore } from './store';

const ARCHIVE_VERSION = 1;

export interface ArchivedCommentRecord {
  archivedAt: string;
  comment: FeedbackComment;
}

export interface FeedbackArchiveStore {
  version: number;
  comments: ArchivedCommentRecord[];
}

export interface ArchiveResolvedResult {
  archivedCount: number;
  remainingCount: number;
  archivePath: string;
  archiveFileCreated: boolean;
}

function archiveStorePath(projectRoot: string): string {
  return path.join(projectRoot, '.feedback', 'archive.json');
}

function emptyArchive(): FeedbackArchiveStore {
  return {
    version: ARCHIVE_VERSION,
    comments: [],
  };
}

function readArchive(projectRoot: string): FeedbackArchiveStore {
  const p = archiveStorePath(projectRoot);
  if (!fs.existsSync(p)) {
    return emptyArchive();
  }
  const raw = fs.readFileSync(p, 'utf-8');
  const data = JSON.parse(raw) as FeedbackArchiveStore;
  if (data.version !== ARCHIVE_VERSION) {
    throw new Error(
      `Unsupported archive version: ${data.version} (expected ${ARCHIVE_VERSION})`
    );
  }
  if (!Array.isArray(data.comments)) {
    data.comments = [];
  }
  return data;
}

function writeArchive(projectRoot: string, archive: FeedbackArchiveStore): void {
  const p = archiveStorePath(projectRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(archive, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, p);
}

export function archiveResolvedComments(
  projectRoot: string,
  store: FeedbackStore
): ArchiveResolvedResult {
  const resolved = store.comments.filter((comment) => comment.status === 'resolved');
  const unresolved = store.comments.filter((comment) => comment.status !== 'resolved');

  if (resolved.length === 0) {
    return {
      archivedCount: 0,
      remainingCount: store.comments.length,
      archivePath: archiveStorePath(projectRoot),
      archiveFileCreated: fs.existsSync(archiveStorePath(projectRoot)),
    };
  }

  const archivePath = archiveStorePath(projectRoot);
  const archiveFileCreated = !fs.existsSync(archivePath);
  const archive = readArchive(projectRoot);
  const archivedAt = new Date().toISOString();
  for (const comment of resolved) {
    archive.comments.push({ archivedAt, comment });
  }
  writeArchive(projectRoot, archive);

  store.comments = unresolved;

  return {
    archivedCount: resolved.length,
    remainingCount: unresolved.length,
    archivePath,
    archiveFileCreated,
  };
}

