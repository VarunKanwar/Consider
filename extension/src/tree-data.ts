import { CommentStatus, FeedbackComment } from './store';

export type CommentStatusFilter = CommentStatus | 'all';

export interface FeedbackFileGroup {
  file: string;
  comments: FeedbackComment[];
}

export function filterCommentsByStatus(
  comments: FeedbackComment[],
  statusFilter: CommentStatusFilter
): FeedbackComment[] {
  if (statusFilter === 'all') {
    return comments.slice();
  }
  return comments.filter((comment) => comment.status === statusFilter);
}

export function groupCommentsByFile(
  comments: FeedbackComment[],
  statusFilter: CommentStatusFilter
): FeedbackFileGroup[] {
  const grouped = new Map<string, FeedbackComment[]>();
  const filtered = filterCommentsByStatus(comments, statusFilter);

  for (const comment of filtered) {
    const existing = grouped.get(comment.file);
    if (existing) {
      existing.push(comment);
    } else {
      grouped.set(comment.file, [comment]);
    }
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([file, fileComments]) => ({
      file,
      comments: fileComments.sort(
        (a, b) => (a.anchor.startLine - b.anchor.startLine) || a.id.localeCompare(b.id)
      ),
    }));
}

