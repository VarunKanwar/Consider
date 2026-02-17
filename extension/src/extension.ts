import * as vscode from 'vscode';
import * as path from 'path';
import {
  readStore,
  writeStore,
  generateCommentId,
  generateReplyId,
  findComment,
  FeedbackComment,
  FeedbackStore,
  Reply,
} from './store';
import { hashAnchorContent, reconcileStoreForExtension } from './reconcile';
import { runSetupAgentIntegration } from './setup';
import { archiveResolvedComments } from './archive';
import { CommentStatusFilter, groupCommentsByFile } from './tree-data';

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

interface FeedbackFileNode {
  kind: 'file';
  file: string;
  comments: FeedbackComment[];
}

interface FeedbackCommentNode {
  kind: 'comment';
  comment: FeedbackComment;
}

type FeedbackTreeNode = FeedbackFileNode | FeedbackCommentNode;

function formatCommentLineRange(comment: FeedbackComment): string {
  const { startLine, endLine } = comment.anchor;
  if (startLine === endLine) {
    return `L${startLine}`;
  }
  return `L${startLine}-${endLine}`;
}

function truncateTreeText(value: string, max = 90): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

class FeedbackCommentsTreeProvider
  implements vscode.TreeDataProvider<FeedbackTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    FeedbackTreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private comments: FeedbackComment[] = [];
  private statusFilter: CommentStatusFilter = 'all';

  constructor(private projectRoot: string) {}

  setStore(store: FeedbackStore): void {
    this.comments = store.comments.slice();
    this.refresh();
  }

  setStatusFilter(statusFilter: CommentStatusFilter): void {
    this.statusFilter = statusFilter;
    this.refresh();
  }

  getStatusFilter(): CommentStatusFilter {
    return this.statusFilter;
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: FeedbackTreeNode): vscode.TreeItem {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(
        element.file,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = `${element.comments.length} comment${
        element.comments.length === 1 ? '' : 's'
      }`;
      item.tooltip = `${element.file}\n${element.comments.length} feedback comment${
        element.comments.length === 1 ? '' : 's'
      }`;
      item.iconPath = new vscode.ThemeIcon('file-code');
      return item;
    }

    const { comment } = element;
    const item = new vscode.TreeItem(
      `${formatCommentLineRange(comment)} ${truncateTreeText(comment.body, 72)}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = `${comment.status} • ${comment.id}`;
    item.tooltip = `${comment.file}:${comment.anchor.startLine}\n\n${comment.body}`;
    item.iconPath = comment.status === 'resolved'
      ? new vscode.ThemeIcon('pass')
      : comment.status === 'stale'
        ? new vscode.ThemeIcon('warning')
        : comment.status === 'orphaned'
          ? new vscode.ThemeIcon('question')
          : new vscode.ThemeIcon('comment');
    item.command = {
      command: 'feedback-loop.openCommentFromTree',
      title: 'Open Feedback Comment',
      arguments: [comment.id],
    };
    item.contextValue = `feedback-comment-${comment.status}`;
    return item;
  }

  getChildren(element?: FeedbackTreeNode): FeedbackTreeNode[] {
    if (!element) {
      return groupCommentsByFile(this.comments, this.statusFilter).map(
        (group) =>
          ({
            kind: 'file',
            file: group.file,
            comments: group.comments,
          }) satisfies FeedbackFileNode
      );
    }
    if (element.kind === 'file') {
      return element.comments.map(
        (comment) =>
          ({
            kind: 'comment',
            comment,
          }) satisfies FeedbackCommentNode
      );
    }
    return [];
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
  private commentsTreeProvider: FeedbackCommentsTreeProvider;
  private commentsTreeView: vscode.TreeView<FeedbackTreeNode>;

  /** Debounce flag to avoid re-reading store during our own writes */
  private suppressWatcher = false;
  private reconcileTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(private context: vscode.ExtensionContext) {
    this.projectRoot = this.getProjectRoot();
    this.commentsTreeProvider = new FeedbackCommentsTreeProvider(this.projectRoot);
    this.commentsTreeView = vscode.window.createTreeView('feedback-loop.comments', {
      treeDataProvider: this.commentsTreeProvider,
      showCollapseAll: true,
    });

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
    this.disposables.push(this.commentsTreeView);

    this.registerCommands();
    this.setupStoreWatcher();
    this.loadAllThreads();
    this.setupDocumentReconciliation();
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
        (arg?: unknown) => {
          if (this.isCommentReply(arg)) {
            this.handleNewComment(arg);
            return;
          }
          void this.handleAddCommentFromCommandPalette();
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

    // Show All Comments (tree view + status filter)
    this.disposables.push(
      vscode.commands.registerCommand('feedback-loop.showAllComments', () => {
        void this.handleShowAllComments();
      })
    );

    // Archive Resolved
    this.disposables.push(
      vscode.commands.registerCommand('feedback-loop.archiveResolved', () => {
        this.handleArchiveResolved();
      })
    );

    this.disposables.push(
      vscode.commands.registerCommand(
        'feedback-loop.openCommentFromTree',
        (commentId: string) => {
          void this.handleOpenCommentFromTree(commentId);
        }
      )
    );

    // Reconcile All
    this.disposables.push(
      vscode.commands.registerCommand('feedback-loop.reconcileAll', () => {
        this.handleReconcileAll();
      })
    );
  }

  // --- Comment handlers ---

  private handleNewComment(reply: vscode.CommentReply): void {
    if (!reply || !reply.thread) {
      vscode.window.showErrorMessage('Could not determine comment thread context.');
      return;
    }
    const thread = reply.thread;
    const document = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === thread.uri.toString()
    );
    this.createRootComment(thread, reply.text, document);
  }

  private async handleAddCommentFromCommandPalette(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Open a file before adding feedback.');
      return;
    }
    if (editor.document.uri.scheme !== 'file') {
      vscode.window.showWarningMessage(
        'Feedback comments can only be added to files on disk.'
      );
      return;
    }

    const selection = editor.selection;
    const startLine = Math.min(selection.start.line, selection.end.line);
    let endLine = Math.max(selection.start.line, selection.end.line);
    if (!selection.isEmpty && selection.end.character === 0 && endLine > startLine) {
      endLine -= 1;
    }

    const body = await vscode.window.showInputBox({
      prompt: 'Write feedback for the agent...',
      placeHolder: 'Type your feedback here',
      ignoreFocusOut: true,
      validateInput: (value) => {
        return value.trim().length === 0 ? 'Feedback cannot be empty.' : null;
      },
    });
    if (!body || body.trim().length === 0) {
      return;
    }

    const thread = this.commentController.createCommentThread(
      editor.document.uri,
      new vscode.Range(startLine, 0, endLine, 0),
      []
    );
    this.createRootComment(thread, body, editor.document);
  }

  private createRootComment(
    thread: vscode.CommentThread,
    body: string,
    document?: vscode.TextDocument
  ): void {
    const normalizedBody = body.trim();
    if (normalizedBody.length === 0) {
      return;
    }

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
        contentHash: hashAnchorContent(targetContent),
        lastAnchorCheck: now,
      },
      status: 'open',
      createdAt: now,
      author: 'human',
      body: normalizedBody,
      thread: [],
    };
    store.comments.push(feedbackComment);
    this.writeStoreSuppress(store);

    // Create the visual comment
    const newComment = new FeedbackReply(
      normalizedBody,
      HUMAN_AUTHOR,
      commentId,
      vscode.CommentMode.Preview
    );
    thread.comments = [newComment];
    this.applyThreadPresentation(thread, 'open');
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;

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

    this.applyThreadPresentation(thread, 'resolved');
  }

  private handleUnresolve(thread: vscode.CommentThread): void {
    const commentId = this.getCommentIdFromThread(thread);
    if (!commentId) return;

    const store = readStore(this.projectRoot);
    const comment = findComment(store, commentId);
    if (!comment) return;

    comment.status = 'open';
    this.writeStoreSuppress(store);

    this.applyThreadPresentation(thread, 'open');
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
    try {
      const result = runSetupAgentIntegration(this.projectRoot, {
        cliSourceDir: path.resolve(this.context.extensionPath, '..', 'cli'),
      });

      const summary: string[] = [];
      summary.push('.feedback scaffolding ready');
      summary.push('CLI deployed to .feedback/bin');
      if (result.gitignoreUpdated) {
        summary.push('.gitignore updated');
      }
      if (result.skillsWritten.length > 0) {
        summary.push(`skills written (${result.skillsWritten.length})`);
      }
      if (result.codexSectionUpdated) {
        summary.push('AGENTS.md updated');
      }
      if (result.usedFallbackToAllAgents) {
        summary.push('no existing agent config detected; installed all integrations');
      }

      vscode.window.showInformationMessage(
        `Feedback Loop setup complete: ${summary.join(', ')}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Feedback setup failed: ${message}`);
    }
  }

  private async handleShowAllComments(): Promise<void> {
    const filterOptions: Array<{ label: string; value: CommentStatusFilter }> = [
      { label: 'All statuses', value: 'all' },
      { label: 'Open only', value: 'open' },
      { label: 'Resolved only', value: 'resolved' },
      { label: 'Stale only', value: 'stale' },
      { label: 'Orphaned only', value: 'orphaned' },
    ];

    const selected = await vscode.window.showQuickPick(filterOptions, {
      placeHolder: 'Choose which feedback status to show in the Feedback Comments view',
      ignoreFocusOut: true,
    });
    if (!selected) {
      return;
    }

    this.commentsTreeProvider.setStatusFilter(selected.value);

    try {
      await vscode.commands.executeCommand('feedback-loop.comments.focus');
    } catch {
      await vscode.commands.executeCommand('workbench.view.explorer');
    }
  }

  private handleArchiveResolved(): void {
    const store = readStore(this.projectRoot);
    const result = archiveResolvedComments(this.projectRoot, store);
    if (result.archivedCount === 0) {
      vscode.window.showInformationMessage(
        'Feedback: No resolved comments to archive.'
      );
      return;
    }

    this.writeStoreSuppress(store);
    this.reloadFromStore();

    vscode.window.showInformationMessage(
      `Feedback: Archived ${result.archivedCount} resolved comment${
        result.archivedCount === 1 ? '' : 's'
      } to .feedback/archive.json.`
    );
  }

  private async handleOpenCommentFromTree(commentId: string): Promise<void> {
    if (!commentId) return;

    const store = readStore(this.projectRoot);
    const comment = findComment(store, commentId);
    if (!comment) {
      vscode.window.showWarningMessage(
        `Feedback comment ${commentId} was not found in the store.`
      );
      return;
    }

    const filePath = path.join(this.projectRoot, comment.file);
    let fileExists = true;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    } catch {
      fileExists = false;
    }
    if (!fileExists) {
      vscode.window.showWarningMessage(
        `Feedback comment ${commentId} points to missing file: ${comment.file}`
      );
      return;
    }

    const document = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
    });

    const startLine = Math.max(0, comment.anchor.startLine - 1);
    const endLine = Math.max(startLine, comment.anchor.endLine - 1);
    const targetRange = new vscode.Range(startLine, 0, endLine, 0);
    editor.selection = new vscode.Selection(targetRange.start, targetRange.start);
    editor.revealRange(
      targetRange,
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
  }

  private handleReconcileAll(): void {
    const store = readStore(this.projectRoot);
    const result = reconcileStoreForExtension(this.projectRoot, store, { force: true });
    if (result.changed) {
      this.writeStoreSuppress(store);
      this.reloadFromStore();
    }
    const summary = result.changed
      ? `updated ${result.updatedComments} comment${result.updatedComments === 1 ? '' : 's'}`
      : 'no anchor updates needed';
    vscode.window.showInformationMessage(
      `Feedback: Reconcile All checked ${result.checkedComments} comment${result.checkedComments === 1 ? '' : 's'}; ${summary}.`
    );
  }

  // --- File/document reconciliation ---

  private setupDocumentReconciliation(): void {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        this.reconcileDocumentFile(document, false);
      })
    );

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.reconcileDocumentFile(document, false);
      })
    );

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.scheduleReconcileForDocument(event.document);
      })
    );

    for (const document of vscode.workspace.textDocuments) {
      this.reconcileDocumentFile(document, false);
    }
  }

  private scheduleReconcileForDocument(document: vscode.TextDocument): void {
    const relativePath = this.getRelativePathIfInProject(document.uri);
    if (!relativePath) return;

    const timerKey = relativePath;
    const existing = this.reconcileTimers.get(timerKey);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.reconcileTimers.delete(timerKey);
      this.reconcileFile(relativePath, false);
      this.syncThreadAnchorsFromDocument(document, relativePath);
    }, 250);

    this.reconcileTimers.set(timerKey, timer);
  }

  private reconcileDocumentFile(document: vscode.TextDocument, force: boolean): void {
    const relativePath = this.getRelativePathIfInProject(document.uri);
    if (!relativePath) return;
    this.reconcileFile(relativePath, force);
  }

  private reconcileFile(relativePath: string, force: boolean): void {
    let store: FeedbackStore;
    try {
      store = readStore(this.projectRoot);
    } catch {
      return;
    }
    const result = reconcileStoreForExtension(this.projectRoot, store, {
      force,
      files: [relativePath],
    });
    if (!result.changed) return;

    this.writeStoreSuppress(store);
    this.reloadFromStore();
  }

  private syncThreadAnchorsFromDocument(
    document: vscode.TextDocument,
    relativePath: string
  ): void {
    if (document.uri.scheme !== 'file') return;

    let store: FeedbackStore;
    try {
      store = readStore(this.projectRoot);
    } catch {
      return;
    }
    const lines = document.getText().split('\n');
    const now = new Date().toISOString();
    let changed = false;

    for (const comment of store.comments) {
      if (comment.status !== 'open' || comment.file !== relativePath) {
        continue;
      }
      const thread = this.threadMap.get(comment.id);
      if (!thread || !thread.range) continue;

      const startLine = thread.range.start.line + 1;
      const endLine = thread.range.end.line + 1;

      const targetContent = lines.slice(startLine - 1, endLine).join('\n');
      const contextBefore = lines.slice(Math.max(0, startLine - 3), Math.max(0, startLine - 1));
      const contextAfter = lines.slice(endLine, Math.min(lines.length, endLine + 2));
      const contentHash = hashAnchorContent(targetContent);

      if (comment.anchor.startLine !== startLine) {
        comment.anchor.startLine = startLine;
        changed = true;
      }
      if (comment.anchor.endLine !== endLine) {
        comment.anchor.endLine = endLine;
        changed = true;
      }
      if (JSON.stringify(comment.anchor.contextBefore || []) !== JSON.stringify(contextBefore)) {
        comment.anchor.contextBefore = contextBefore;
        changed = true;
      }
      if (JSON.stringify(comment.anchor.contextAfter || []) !== JSON.stringify(contextAfter)) {
        comment.anchor.contextAfter = contextAfter;
        changed = true;
      }
      if ((comment.anchor.targetContent || '') !== targetContent) {
        comment.anchor.targetContent = targetContent;
        changed = true;
      }
      if ((comment.anchor.contentHash || '') !== contentHash) {
        comment.anchor.contentHash = contentHash;
        changed = true;
      }
      if (comment.anchor.lastAnchorCheck !== now) {
        comment.anchor.lastAnchorCheck = now;
        changed = true;
      }
    }

    if (changed) {
      this.writeStoreSuppress(store);
    }
  }

  private getRelativePathIfInProject(uri: vscode.Uri): string | null {
    if (uri.scheme !== 'file') {
      return null;
    }
    const relativePath = path.relative(this.projectRoot, uri.fsPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null;
    }
    return relativePath.replace(/\\/g, '/');
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
    this.commentsTreeProvider.setStore(store);

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

    this.applyThreadPresentation(thread, comment.status);

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
    this.commentsTreeProvider.setStore(store);

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
    this.applyThreadPresentation(thread, comment.status);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;

    this.threadMap.set(comment.id, thread);
  }

  // --- Helpers ---

  private isCommentReply(value: unknown): value is vscode.CommentReply {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Partial<vscode.CommentReply>;
    return typeof candidate.text === 'string' && candidate.thread !== undefined;
  }

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

  private applyThreadPresentation(
    thread: vscode.CommentThread,
    status: FeedbackComment['status']
  ): void {
    thread.label = status === 'stale'
      ? 'Stale Feedback'
      : status === 'orphaned'
        ? 'Orphaned Feedback'
        : 'Feedback';

    if (status === 'resolved') {
      thread.state = vscode.CommentThreadState.Resolved;
      thread.contextValue = 'feedback-thread-resolved';
      return;
    }

    thread.state = vscode.CommentThreadState.Unresolved;
    thread.contextValue = `feedback-thread-${status}`;
  }

  /**
   * Write to store with watcher suppression to avoid re-reading our own writes.
   */
  private writeStoreSuppress(store: FeedbackStore): void {
    this.suppressWatcher = true;
    this.commentsTreeProvider.setStore(store);
    writeStore(this.projectRoot, store);
    // Re-enable watcher after a short delay to let the file event settle
    setTimeout(() => {
      this.suppressWatcher = false;
    }, 500);
  }

  dispose(): void {
    for (const timer of this.reconcileTimers.values()) {
      clearTimeout(timer);
    }
    this.reconcileTimers.clear();

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
