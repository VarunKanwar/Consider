import { FeedbackComment } from './store';

export interface FeedbackFileGroup {
  file: string;
  comments: FeedbackComment[];
}

export interface CommentVisibilityFilter {
  showResolved: boolean;
  showStale: boolean;
}

export const DEFAULT_COMMENT_VISIBILITY_FILTER: CommentVisibilityFilter = {
  showResolved: true,
  showStale: true,
};

function matchesVisibilityFilter(
  comment: FeedbackComment,
  visibilityFilter: CommentVisibilityFilter
): boolean {
  if (!visibilityFilter.showResolved && comment.workflowState === 'resolved') {
    return false;
  }
  if (!visibilityFilter.showStale && comment.anchorState === 'stale') {
    return false;
  }
  return true;
}

export function filterCommentsByVisibility(
  comments: FeedbackComment[],
  visibilityFilter: CommentVisibilityFilter
): FeedbackComment[] {
  return comments.filter((comment) => matchesVisibilityFilter(comment, visibilityFilter));
}

export function groupCommentsByFile(
  comments: FeedbackComment[],
  visibilityFilter: CommentVisibilityFilter
): FeedbackFileGroup[] {
  const grouped = new Map<string, FeedbackComment[]>();
  const filtered = filterCommentsByVisibility(comments, visibilityFilter);

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
