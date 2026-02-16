import * as vscode from 'vscode';
import * as path from 'path';
import {
  readStore,
  writeStore,
  generateCommentId,
  generateReplyId,
  findComment,
  storePath,
  emptyStore,
  FeedbackComment,
  FeedbackStore,
  Reply,
} from './store';

// --- Comment author labels ---
const HUMAN_AUTHOR: vscode.CommentAuthorInformation = {
  name: 'Developer',
};

const AGENT_AUTHOR: vscode.CommentAuthorInformation = {
  name: 'Agent',
};

/**
 * Our custom Comment implementation that tracks the store's reply ID.
 */
class FeedbackReply implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode: vscode.CommentMode;
  author: vscode.CommentAuthorInformation;
  label?: string;
  /** The reply/comment ID in the feedback store */
  storeId: string;

  constructor(
    body: string,
    author: vscode.CommentAuthorInformation,
    storeId: string,
    mode: vscode.CommentMode = vscode.CommentMode.Preview
  ) {
    this.body = new vscode.MarkdownString(body);
    this.author = author;
    this.mode = mode;
    this.storeId = storeId;
    if (author === AGENT_AUTHOR) {
      this.label = 'Agent';
    }
  }
}

/**
 * Main extension controller. Manages the CommentController, store sync,
 * and file watching.
 */
class FeedbackLoopController {
  private commentController: vscode.CommentController;
  private projectRoot: string;
  private storeWatcher: vscode.FileSystemWatcher | undefined;
  private disposables: vscode.Disposable[] = [];
  /**
   * Map of comment ID -> CommentThread for quick lookup.
   * Lets us update threads when the store changes externally (agent replies).
   */
  private threadMap: Map<string, vscode.CommentThread> = new Map();

  /** Debounce flag to avoid re-reading store during our own writes */
  private suppressWatcher = false;

  constructor(private context: vscode.ExtensionContext) {
    this.projectRoot = this.getProjectRoot();

    this.commentController = vscode.comments.createCommentController(
      'feedback-loop',
      'Feedback Loop'
    );
    this.commentController.commentingRangeProvider = {
      provideCommentingRanges: (
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
      ) => {
        // Allow commenting on any line in any file
        return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
      },
    };
    // Set the reaction handler to null to disable reactions UI
    this.commentController.options = {
      prompt: 'Write feedback for the agent...',
      placeHolder: 'Type your feedback here',
    };
    this.disposables.push(this.commentController);

    this.registerCommands();
    this.setupStoreWatcher();
    this.loadAllThreads();
  }

  private getProjectRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No workspace folder open.');
    }
    return folders[0].uri.fsPath;
  }

  // --- Commands ---

  private registerCommands(): void {
    // "Add Comment" is handled via the CommentController's createCommentThread
    // through the commenting range provider. The user clicks the "+" gutter icon
    // and the Comments API creates the thread. We hook into it via the reply handler.

    // Handle new comment creation (user types in the empty comment thread)
    this.disposables.push(
      vscode.commands.registerCommand(
        'feedback-loop.addComment',
        (reply: vscode.CommentReply) => {
          this.handleNewComment(reply);
        }
      )
    );

    // Handle reply to existing thread
    this.disposables.push(
      vscode.commands.registerCommand(
        'feedback-loop.replyToComment',
        (reply: vscode.CommentReply) => {
          this.handleReply(reply);
        }
      )
    );

    // Resolve thread
    this.disposables.push(
      vscode.commands.registerCommand(
        'feedback-loop.resolveThread',
        (thread: vscode.CommentThread) => {
          this.handleResolve(thread);
        }
      )
    );

    // Unresolve (reopen) thread
    this.disposables.push(
      vscode.commands.registerCommand(
        'feedback-loop.unresolveThread',
        (thread: vscode.CommentThread) => {
          this.handleUnresolve(thread);
        }
      )
    );

    // Delete comment
    this.disposables.push(
      vscode.commands.registerCommand(
        'feedback-loop.deleteComment',
        (comment: FeedbackReply) => {
          this.handleDeleteComment(comment);
        }
      )
    );

    // Setup Agent Integration (Phase 4 stub — just ensures .feedback/ exists)
    this.disposables.push(
      vscode.commands.registerCommand(
        'feedback-loop.setupAgentIntegration',
        () => {
          this.handleSetupAgentIntegration();
        }
      )
    );

    // Show All Comments (Phase 5 stub)
    this.disposables.push(
      vscode.commands.registerCommand('feedback-loop.showAllComments', () => {
        vscode.window.showInformationMessage(
          'Feedback: Show All Comments — coming in Phase 5.'
        );
      })
    );

    // Archive Resolved (Phase 5 stub)
    this.disposables.push(
      vscode.commands.registerCommand('feedback-loop.archiveResolved', () => {
        vscode.window.showInformationMessage(
          'Feedback: Archive Resolved — coming in Phase 5.'
        );
      })
    );

    // Reconcile All (Phase 3 stub)
    this.disposables.push(
      vscode.commands.registerCommand('feedback-loop.reconcileAll', () => {
        vscode.window.showInformationMessage(
          'Feedback: Reconcile All — coming in Phase 3.'
        );
      })
    );
  }

  // --- Comment handlers ---

  private handleNewComment(reply: vscode.CommentReply): void {
    const thread = reply.thread;
    const document = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === thread.uri.toString()
    );

    const relativePath = path.relative(this.projectRoot, thread.uri.fsPath);
    const range = thread.range;
    if (!range) {
      vscode.window.showErrorMessage('Cannot determine comment location.');
      return;
    }
    const startLine = range.start.line + 1; // 1-based
    const endLine = range.end.line + 1;

    // Build anchor data
    const lines = document ? document.getText().split('\n') : [];
    const targetLines: string[] = [];
    for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
      targetLines.push(lines[i]);
    }
    const targetContent = targetLines.join('\n');

    // Context lines (up to 2 before and after)
    const contextBefore: string[] = [];
    for (let i = Math.max(0, startLine - 3); i < startLine - 1; i++) {
      if (i < lines.length) contextBefore.push(lines[i]);
    }
    const contextAfter: string[] = [];
    for (let i = endLine; i < Math.min(lines.length, endLine + 2); i++) {
      contextAfter.push(lines[i]);
    }

    const commentId = generateCommentId();
    const now = new Date().toISOString();

    // Save to store
    const store = readStore(this.projectRoot);
    const feedbackComment: FeedbackComment = {
      id: commentId,
      file: relativePath.replace(/\\/g, '/'), // normalize to forward slashes
      anchor: {
        startLine,
        endLine,
        contextBefore,
        contextAfter,
        targetContent,
        lastAnchorCheck: now,
      },
      status: 'open',
      createdAt: now,
      author: 'human',
      body: reply.text,
      thread: [],
    };
    store.comments.push(feedbackComment);
    this.writeStoreSuppress(store);

    // Create the visual comment
    const newComment = new FeedbackReply(
      reply.text,
      HUMAN_AUTHOR,
      commentId,
      vscode.CommentMode.Preview
    );
    thread.comments = [newComment];
    thread.label = 'Feedback';
    thread.contextValue = 'feedback-thread-open';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

    // Track the thread
    this.threadMap.set(commentId, thread);
  }

  private handleReply(reply: vscode.CommentReply): void {
    const thread = reply.thread;
    const commentId = this.getCommentIdFromThread(thread);
    if (!commentId) {
      vscode.window.showErrorMessage('Could not find the feedback comment for this thread.');
      return;
    }

    const store = readStore(this.projectRoot);
    const comment = findComment(store, commentId);
    if (!comment) {
      vscode.window.showErrorMessage(`Comment ${commentId} not found in store.`);
      return;
    }

    const replyId = generateReplyId();
    const now = new Date().toISOString();

    const storeReply: Reply = {
      id: replyId,
      author: 'human',
      body: reply.text,
      createdAt: now,
    };
    comment.thread.push(storeReply);
    this.writeStoreSuppress(store);

    // Add to visual thread
    const newReply = new FeedbackReply(
      reply.text,
      HUMAN_AUTHOR,
      replyId,
      vscode.CommentMode.Preview
    );
    thread.comments = [...thread.comments, newReply];
  }

  private handleResolve(thread: vscode.CommentThread): void {
    const commentId = this.getCommentIdFromThread(thread);
    if (!commentId) return;

    const store = readStore(this.projectRoot);
    const comment = findComment(store, commentId);
    if (!comment) return;

    comment.status = 'resolved';
    this.writeStoreSuppress(store);

    thread.contextValue = 'feedback-thread-resolved';
    thread.state = vscode.CommentThreadState.Resolved;
  }

  private handleUnresolve(thread: vscode.CommentThread): void {
    const commentId = this.getCommentIdFromThread(thread);
    if (!commentId) return;

    const store = readStore(this.projectRoot);
    const comment = findComment(store, commentId);
    if (!comment) return;

    comment.status = 'open';
    this.writeStoreSuppress(store);

    thread.contextValue = 'feedback-thread-open';
    thread.state = vscode.CommentThreadState.Unresolved;
  }

  private handleDeleteComment(comment: FeedbackReply): void {
    // Find which thread contains this comment
    for (const [commentId, thread] of this.threadMap) {
      const comments = thread.comments as FeedbackReply[];
      if (comments.some((c) => c.storeId === comment.storeId)) {
        // If it's the root comment (first in thread), remove the whole thread
        if (comments[0]?.storeId === comment.storeId) {
          const store = readStore(this.projectRoot);
          store.comments = store.comments.filter((c) => c.id !== commentId);
          this.writeStoreSuppress(store);
          thread.dispose();
          this.threadMap.delete(commentId);
        } else {
          // It's a reply — remove just the reply
          const store = readStore(this.projectRoot);
          const storeComment = findComment(store, commentId);
          if (storeComment) {
            storeComment.thread = storeComment.thread.filter(
              (r) => r.id !== comment.storeId
            );
            this.writeStoreSuppress(store);
          }
          thread.comments = comments.filter(
            (c) => c.storeId !== comment.storeId
          );
        }
        return;
      }
    }
  }

  private handleSetupAgentIntegration(): void {
    // Phase 2: minimal stub — just ensure .feedback/ directory exists
    const fs = require('fs') as typeof import('fs');
    const feedbackDir = path.join(this.projectRoot, '.feedback');
    if (!fs.existsSync(feedbackDir)) {
      fs.mkdirSync(feedbackDir, { recursive: true });
    }
    const sp = storePath(this.projectRoot);
    if (!fs.existsSync(sp)) {
      writeStore(this.projectRoot, emptyStore());
    }
    vscode.window.showInformationMessage(
      'Feedback Loop: .feedback/ directory initialized. Full agent setup coming in Phase 4.'
    );
  }

  // --- Store file watcher ---

  private setupStoreWatcher(): void {
    const pattern = new vscode.RelativePattern(
      this.projectRoot,
      '.feedback/store.json'
    );
    this.storeWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.storeWatcher.onDidChange(() => {
      if (this.suppressWatcher) return;
      this.reloadFromStore();
    });

    this.storeWatcher.onDidCreate(() => {
      if (this.suppressWatcher) return;
      this.reloadFromStore();
    });

    this.disposables.push(this.storeWatcher);
  }

  /**
   * Reload all comment threads from the store.
   * Called when the store file changes externally (e.g., agent replied via CLI).
   */
  private reloadFromStore(): void {
    let store: FeedbackStore;
    try {
      store = readStore(this.projectRoot);
    } catch {
      // Store might be mid-write or corrupt temporarily; ignore
      return;
    }

    // Build a set of comment IDs in the store for diffing
    const storeIds = new Set(store.comments.map((c) => c.id));

    // Remove threads for comments that no longer exist in the store
    for (const [commentId, thread] of this.threadMap) {
      if (!storeIds.has(commentId)) {
        thread.dispose();
        this.threadMap.delete(commentId);
      }
    }

    // Update existing threads and create new ones
    for (const comment of store.comments) {
      const existingThread = this.threadMap.get(comment.id);
      if (existingThread) {
        // Update thread contents (picks up new replies from agent)
        this.updateThread(existingThread, comment);
      } else {
        // New comment appeared (probably shouldn't happen for agent, but handle it)
        this.createThreadFromStore(comment);
      }
    }
  }

  /**
   * Update an existing thread's comments to match the store.
   */
  private updateThread(thread: vscode.CommentThread, comment: FeedbackComment): void {
    // Rebuild the comments array from the store data
    const comments: FeedbackReply[] = [];

    // Root comment
    comments.push(
      new FeedbackReply(
        comment.body,
        comment.author === 'human' ? HUMAN_AUTHOR : AGENT_AUTHOR,
        comment.id
      )
    );

    // Replies
    for (const reply of comment.thread) {
      comments.push(
        new FeedbackReply(
          reply.body,
          reply.author === 'human' ? HUMAN_AUTHOR : AGENT_AUTHOR,
          reply.id
        )
      );
    }

    thread.comments = comments;

    // Update status
    if (comment.status === 'resolved') {
      thread.state = vscode.CommentThreadState.Resolved;
      thread.contextValue = 'feedback-thread-resolved';
    } else {
      thread.state = vscode.CommentThreadState.Unresolved;
      thread.contextValue = `feedback-thread-${comment.status}`;
    }

    // Update range if anchor changed (will matter in Phase 3)
    const newRange = new vscode.Range(
      comment.anchor.startLine - 1,
      0,
      comment.anchor.endLine - 1,
      0
    );
    thread.range = newRange;
  }

  // --- Load all threads on startup ---

  private loadAllThreads(): void {
    let store: FeedbackStore;
    try {
      store = readStore(this.projectRoot);
    } catch {
      return; // No store yet
    }

    for (const comment of store.comments) {
      this.createThreadFromStore(comment);
    }
  }

  private createThreadFromStore(comment: FeedbackComment): void {
    const fileUri = vscode.Uri.file(
      path.join(this.projectRoot, comment.file)
    );
    const range = new vscode.Range(
      comment.anchor.startLine - 1,
      0,
      comment.anchor.endLine - 1,
      0
    );

    const thread = this.commentController.createCommentThread(
      fileUri,
      range,
      []
    );

    // Build comments
    const comments: FeedbackReply[] = [];

    comments.push(
      new FeedbackReply(
        comment.body,
        comment.author === 'human' ? HUMAN_AUTHOR : AGENT_AUTHOR,
        comment.id
      )
    );

    for (const reply of comment.thread) {
      comments.push(
        new FeedbackReply(
          reply.body,
          reply.author === 'human' ? HUMAN_AUTHOR : AGENT_AUTHOR,
          reply.id
        )
      );
    }

    thread.comments = comments;
    thread.label = comment.status === 'stale' ? 'Stale Feedback' :
                   comment.status === 'orphaned' ? 'Orphaned Feedback' :
                   'Feedback';
    thread.contextValue = comment.status === 'resolved'
      ? 'feedback-thread-resolved'
      : `feedback-thread-${comment.status}`;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;

    if (comment.status === 'resolved') {
      thread.state = vscode.CommentThreadState.Resolved;
    }

    this.threadMap.set(comment.id, thread);
  }

  // --- Helpers ---

  /**
   * Get the store comment ID from a thread by looking at the first comment.
   */
  private getCommentIdFromThread(thread: vscode.CommentThread): string | undefined {
    const comments = thread.comments as FeedbackReply[];
    if (comments.length > 0) {
      return comments[0].storeId;
    }
    return undefined;
  }

  /**
   * Write to store with watcher suppression to avoid re-reading our own writes.
   */
  private writeStoreSuppress(store: FeedbackStore): void {
    this.suppressWatcher = true;
    writeStore(this.projectRoot, store);
    // Re-enable watcher after a short delay to let the file event settle
    setTimeout(() => {
      this.suppressWatcher = false;
    }, 500);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const thread of this.threadMap.values()) {
      thread.dispose();
    }
    this.threadMap.clear();
  }
}

// --- Extension lifecycle ---

let controller: FeedbackLoopController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  try {
    controller = new FeedbackLoopController(context);
    context.subscriptions.push({ dispose: () => controller?.dispose() });
  } catch (e) {
    // No workspace folder open — register commands that show a warning
    const cmds = [
      'feedback-loop.addComment',
      'feedback-loop.setupAgentIntegration',
      'feedback-loop.showAllComments',
      'feedback-loop.archiveResolved',
      'feedback-loop.reconcileAll',
    ];
    for (const cmd of cmds) {
      context.subscriptions.push(
        vscode.commands.registerCommand(cmd, () => {
          vscode.window.showWarningMessage(
            'Feedback Loop requires an open workspace folder.'
          );
        })
      );
    }
  }
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
