import * as vscode from 'vscode';
import * as fs from 'fs';
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
  getCommentStatus,
  hasUnseenHumanActivity,
} from './store';
import { hashAnchorContent, reconcileStoreForExtension } from './reconcile';
import {
  SetupIntegrationInstall,
  runSetupAgentIntegration,
  runUninstallAgentIntegration,
  SetupIntegrationTarget,
} from './setup';
import { archiveResolvedComments } from './archive';
import {
  CommentVisibilityFilter,
  DEFAULT_COMMENT_VISIBILITY_FILTER,
  groupCommentsByFile,
} from './tree-data';

// --- Comment author labels ---
const HUMAN_AUTHOR: vscode.CommentAuthorInformation = {
  name: 'Developer',
};

const AGENT_AUTHOR: vscode.CommentAuthorInformation = {
  name: 'Agent',
};

const MAX_PER_LINE_COMMENTING_RANGES = 5000;

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
    mode: vscode.CommentMode = vscode.CommentMode.Preview,
    label?: string
  ) {
    this.body = new vscode.MarkdownString(body);
    this.author = author;
    this.mode = mode;
    this.storeId = storeId;
    if (typeof label === 'string' && label.length > 0) {
      this.label = label;
    } else if (author === AGENT_AUTHOR) {
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
  nodeId: string;
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

function workflowTagText(state: FeedbackComment['workflowState']): string {
  return state === 'resolved' ? 'Resolved' : '';
}

function anchorTagText(state: FeedbackComment['anchorState']): string {
  if (state === 'stale') {
    return 'Stale';
  }
  if (state === 'orphaned') {
    return 'Orphaned';
  }
  return '';
}

function statusTagText(comment: FeedbackComment): string {
  const parts: string[] = [];
  const workflow = workflowTagText(comment.workflowState);
  const anchor = anchorTagText(comment.anchorState);
  if (workflow.length > 0) {
    parts.push(workflow);
  }
  if (anchor.length > 0) {
    parts.push(anchor);
  }
  return parts.join(' • ');
}

class FeedbackCommentsTreeProvider
  implements vscode.TreeDataProvider<FeedbackTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    FeedbackTreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private comments: FeedbackComment[] = [];
  private visibilityFilter: CommentVisibilityFilter = {
    ...DEFAULT_COMMENT_VISIBILITY_FILTER,
  };
  private fileNodes: FeedbackFileNode[] = [];
  private commentNodesById: Map<string, FeedbackCommentNode> = new Map();
  private nodeSequence = 0;

  constructor(private projectRoot: string) {}

  setStore(store: FeedbackStore): void {
    this.comments = store.comments.slice();
    this.rebuildNodes();
    this.refresh();
  }

  setVisibilityFilter(visibilityFilter: CommentVisibilityFilter): void {
    this.visibilityFilter = {
      showResolved: visibilityFilter.showResolved,
      showStale: visibilityFilter.showStale,
    };
    this.rebuildNodes();
    this.refresh();
  }

  getVisibilityFilter(): CommentVisibilityFilter {
    return { ...this.visibilityFilter };
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
    const status = getCommentStatus(comment);
    const unseen = hasUnseenHumanActivity(comment) ? 'unseen' : 'seen';
    const statusText = statusTagText(comment);
    const item = new vscode.TreeItem(
      `${formatCommentLineRange(comment)} ${truncateTreeText(comment.body, 72)}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = element.nodeId;
    item.description = statusText.length > 0
      ? `${statusText} • ${comment.id}`
      : comment.id;
    item.tooltip = `${comment.file}:${comment.anchor.startLine}\n${statusText.length > 0 ? statusText : 'Open'} • ${unseen}\n\n${comment.body}`;
    item.iconPath = comment.anchorState === 'orphaned'
      ? new vscode.ThemeIcon('question')
      : comment.anchorState === 'stale'
        ? new vscode.ThemeIcon('warning')
        : comment.workflowState === 'resolved'
          ? new vscode.ThemeIcon('pass')
          : new vscode.ThemeIcon('comment');
    item.command = {
      command: 'feedback-loop.openCommentFromTree',
      title: 'Open Feedback Comment',
      arguments: [comment.id],
    };
    item.contextValue = `feedback-comment-${status}`;
    return item;
  }

  getChildren(element?: FeedbackTreeNode): FeedbackTreeNode[] {
    if (!element) {
      return this.fileNodes;
    }
    if (element.kind === 'file') {
      const children: FeedbackCommentNode[] = [];
      for (const comment of element.comments) {
        const node = this.commentNodesById.get(comment.id);
        if (node) {
          children.push(node);
        }
      }
      return children;
    }
    return [];
  }

  private rebuildNodes(): void {
    const grouped = groupCommentsByFile(this.comments, this.visibilityFilter);
    this.fileNodes = grouped.map(
      (group) =>
        ({
          kind: 'file',
          file: group.file,
          comments: group.comments,
        }) satisfies FeedbackFileNode
    );
    this.commentNodesById.clear();

    for (const fileNode of this.fileNodes) {
      for (const comment of fileNode.comments) {
        const commentNode = {
          kind: 'comment',
          comment,
          nodeId: `feedback-comment-node-${comment.id}-${++this.nodeSequence}`,
        } satisfies FeedbackCommentNode;
        this.commentNodesById.set(comment.id, commentNode);
      }
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
  private commentsTreeProvider: FeedbackCommentsTreeProvider;
  private commentsTreeView: vscode.TreeView<FeedbackTreeNode>;

  /** Debounce flag to avoid re-reading store during our own writes */
  private suppressWatcher = false;
  private reconcileTimers: Map<string, NodeJS.Timeout> = new Map();
  private commentVisibilityFilter: CommentVisibilityFilter = {
    ...DEFAULT_COMMENT_VISIBILITY_FILTER,
  };

  constructor(private context: vscode.ExtensionContext) {
    this.projectRoot = this.getProjectRoot();
    this.commentsTreeProvider = new FeedbackCommentsTreeProvider(this.projectRoot);
    this.commentsTreeView = vscode.window.createTreeView('feedback-loop.comments', {
      treeDataProvider: this.commentsTreeProvider,
      showCollapseAll: true,
    });

    this.commentController = vscode.comments.createCommentController(
      'feedback-loop',
      'Feedback Loop Annotations'
    );
    this.commentController.commentingRangeProvider = {
      provideCommentingRanges: (
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
      ) => {
        return this.buildCommentingRanges(document);
      },
    };
    // Set the reaction handler to null to disable reactions UI
    this.commentController.options = {
      prompt: '',
    };
    this.disposables.push(this.commentController);
    this.disposables.push(this.commentsTreeView);

    this.registerCommands();
    this.setupStoreWatcher();
    this.loadAllThreads();
    this.setupDocumentReconciliation();

    if (this.context.extensionMode !== vscode.ExtensionMode.Test) {
      void this.maybePromptForSetup();
    }
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

    // Setup Agent Integration
    this.disposables.push(
      vscode.commands.registerCommand(
        'feedback-loop.setupAgentIntegration',
        () => {
          void this.handleSetupAgentIntegration();
        }
      )
    );

    this.disposables.push(
      vscode.commands.registerCommand(
        'feedback-loop.uninstallAgentIntegration',
        () => {
          void this.handleUninstallAgentIntegration();
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
    this.disposables.push(
      vscode.commands.registerCommand(
        'feedback-loop.toggleCommentThreadFromTree',
        (arg?: unknown) => {
          this.handleToggleCommentThreadFromTree(arg);
        }
      )
    );

    // Reconcile All
    this.disposables.push(
      vscode.commands.registerCommand('feedback-loop.reconcileAll', () => {
        this.handleReconcileAll();
      })
    );

    if (this.context.extensionMode === vscode.ExtensionMode.Test) {
      this.disposables.push(
        vscode.commands.registerCommand('feedback-loop.debug.commentingRanges', () => {
          const active = vscode.window.activeTextEditor;
          if (!active) {
            return [];
          }
          return this.buildCommentingRanges(active.document).map((range) => ({
            startLine: range.start.line,
            startCharacter: range.start.character,
            endLine: range.end.line,
            endCharacter: range.end.character,
          }));
        })
      );
    }
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
      prompt: '',
      placeHolder: '',
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
      this.buildDocumentLineRange(editor.document, startLine, endLine),
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
      workflowState: 'open',
      anchorState: 'anchored',
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
      commentId
    );
    thread.comments = [newComment];
    this.applyThreadPresentation(thread, feedbackComment);
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
    if (comment.workflowState === 'resolved') {
      vscode.window.showInformationMessage(
        'This thread is resolved. Use Unresolve before replying.'
      );
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

    comment.workflowState = 'resolved';
    this.writeStoreSuppress(store);

    this.applyThreadPresentation(thread, comment);
  }

  private handleUnresolve(thread: vscode.CommentThread): void {
    const commentId = this.getCommentIdFromThread(thread);
    if (!commentId) return;

    const store = readStore(this.projectRoot);
    const comment = findComment(store, commentId);
    if (!comment) return;

    comment.workflowState = 'open';
    this.writeStoreSuppress(store);

    this.applyThreadPresentation(thread, comment);
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

  private async maybePromptForSetup(): Promise<void> {
    const promptStateKey = 'feedback-loop.setupPromptShown';
    const storeExists = fs.existsSync(path.join(this.projectRoot, '.feedback', 'store.json'));
    if (storeExists) {
      return;
    }
    if (this.context.workspaceState.get<boolean>(promptStateKey)) {
      return;
    }

    await this.context.workspaceState.update(promptStateKey, true);

    const selected = await vscode.window.showInformationMessage(
      'Feedback Loop is installed for this workspace. Run setup to initialize .feedback and optional agent integrations.',
      'Set Up Now',
      'Later'
    );
    if (selected === 'Set Up Now') {
      await this.handleSetupAgentIntegration();
    }
  }

  private integrationTargetLabel(target: SetupIntegrationTarget): string {
    return target === 'claude'
      ? 'Claude'
      : target === 'opencode'
        ? 'OpenCode'
        : 'Codex';
  }

  private formatIntegrationTargets(targets: SetupIntegrationTarget[]): string {
    return targets.map((target) => this.integrationTargetLabel(target)).join(', ');
  }

  private integrationScopePath(
    target: SetupIntegrationTarget,
    scope: 'project' | 'home'
  ): string {
    const projectPath = target === 'claude'
      ? '.claude/skills/feedback-loop/SKILL.md'
      : target === 'opencode'
        ? '.opencode/skills/feedback-loop/SKILL.md'
        : '.codex/skills/feedback-loop/SKILL.md';
    const homePath = target === 'claude'
      ? '~/.claude/skills/feedback-loop/SKILL.md'
      : target === 'opencode'
        ? '~/.opencode/skills/feedback-loop/SKILL.md'
        : '~/.codex/skills/feedback-loop/SKILL.md';
    return scope === 'home' ? homePath : projectPath;
  }

  private formatIntegrationInstalls(
    installs: SetupIntegrationInstall[]
  ): string {
    return installs
      .map((install) => {
        const scopeLabel = install.scope === 'home' ? 'home' : 'workspace';
        return `${this.integrationTargetLabel(install.target)} (${scopeLabel})`;
      })
      .join(', ');
  }

  private async promptForSetupPlan(): Promise<
    { addGitignoreEntry: boolean; integrationInstalls: SetupIntegrationInstall[] } | undefined
  > {
    const targets: SetupIntegrationTarget[] = ['claude', 'opencode', 'codex'];
    const items = targets.map((target) => ({
      target,
      label: this.integrationTargetLabel(target),
      projectPath: this.integrationScopePath(target, 'project'),
      homePath: this.integrationScopePath(target, 'home'),
    }));

    const nonce = Math.random().toString(36).slice(2, 12);
    const itemsJson = JSON.stringify(items);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Feedback Loop Agent Skills</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 16px;
    }
    h1 {
      font-size: 15px;
      margin: 0 0 12px;
      font-weight: 600;
    }
    p {
      margin: 0 0 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .section-title {
      font-size: 12px;
      font-weight: 600;
      margin: 14px 0 8px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .setting {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      font-size: 12px;
    }
    .row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 10px;
      align-items: center;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 8px;
      background: var(--vscode-editorWidget-background);
    }
    .title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .path {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      word-break: break-all;
    }
    .scope-wrap {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      min-width: 170px;
      justify-content: flex-end;
    }
    .switch {
      position: relative;
      display: inline-block;
      width: 42px;
      height: 22px;
      flex-shrink: 0;
    }
    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .slider {
      position: absolute;
      cursor: pointer;
      inset: 0;
      background-color: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 999px;
      transition: 0.15s;
    }
    .slider::before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 2px;
      top: 2px;
      background-color: var(--vscode-foreground);
      border-radius: 50%;
      transition: 0.15s;
    }
    .switch input:checked + .slider::before {
      transform: translateX(20px);
    }
    .switch input:checked + .slider {
      background-color: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 14px;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <h1>Feedback Setup</h1>
  <p>Configure workspace files and optional agent skills in one step.</p>
  <div class="section-title">Project Settings</div>
  <label class="setting">
    <input type="checkbox" id="gitignore" checked />
    <span>Add <code>.feedback/</code> to <code>.gitignore</code></span>
  </label>
  <div class="section-title">Agent Skills</div>
  <p>Select agents to install and set each scope with the switch (Workspace or Home).</p>
  <div id="rows"></div>
  <div class="actions">
    <button class="secondary" id="cancel">Cancel</button>
    <button id="submit">Continue</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const items = ${itemsJson};

    const rows = document.getElementById('rows');
    for (const item of items) {
      const wrapper = document.createElement('div');
      wrapper.className = 'row';

      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.id = \`enabled-\${item.target}\`;

      const middle = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = item.label;
      const path = document.createElement('div');
      path.className = 'path';
      path.id = \`path-\${item.target}\`;
      path.textContent = item.projectPath;
      middle.appendChild(title);
      middle.appendChild(path);

      const right = document.createElement('div');
      right.className = 'scope-wrap';
      const leftLabel = document.createElement('span');
      leftLabel.textContent = 'Workspace';
      const switchLabel = document.createElement('label');
      switchLabel.className = 'switch';
      const scope = document.createElement('input');
      scope.type = 'checkbox';
      scope.id = \`scope-\${item.target}\`;
      const slider = document.createElement('span');
      slider.className = 'slider';
      switchLabel.appendChild(scope);
      switchLabel.appendChild(slider);
      const rightLabel = document.createElement('span');
      rightLabel.textContent = 'Home';

      right.appendChild(leftLabel);
      right.appendChild(switchLabel);
      right.appendChild(rightLabel);

      const setScopeEnabled = () => {
        const isEnabled = enabled.checked;
        scope.disabled = !isEnabled;
        right.style.opacity = isEnabled ? '1' : '0.65';
      };
      const refreshPath = () => {
        const home = scope.checked;
        path.textContent = home ? item.homePath : item.projectPath;
      };
      enabled.addEventListener('change', setScopeEnabled);
      scope.addEventListener('change', refreshPath);
      setScopeEnabled();
      refreshPath();

      wrapper.appendChild(enabled);
      wrapper.appendChild(middle);
      wrapper.appendChild(right);
      rows.appendChild(wrapper);
    }

    document.getElementById('submit').addEventListener('click', () => {
      const installs = [];
      for (const item of items) {
        const enabled = document.getElementById(\`enabled-\${item.target}\`);
        const scope = document.getElementById(\`scope-\${item.target}\`);
        if (!enabled.checked) continue;
        installs.push({
          target: item.target,
          scope: scope.checked ? 'home' : 'project',
        });
      }
      const addGitignoreEntry = document.getElementById('gitignore').checked;
      vscode.postMessage({ type: 'submit', installs, addGitignoreEntry });
    });

    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
  </script>
</body>
</html>`;

    return await new Promise<
      { addGitignoreEntry: boolean; integrationInstalls: SetupIntegrationInstall[] } | undefined
    >((resolve) => {
      const panel = vscode.window.createWebviewPanel(
        'feedbackLoop.setupIntegrations',
        'Feedback: Setup',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
        }
      );
      panel.webview.html = html;

      let done = false;
      const finish = (
        value:
          | { addGitignoreEntry: boolean; integrationInstalls: SetupIntegrationInstall[] }
          | undefined
      ): void => {
        if (done) {
          return;
        }
        done = true;
        panel.dispose();
        resolve(value);
      };

      panel.webview.onDidReceiveMessage((message) => {
        if (
          message &&
          message.type === 'submit' &&
          Array.isArray(message.installs) &&
          typeof message.addGitignoreEntry === 'boolean'
        ) {
          const installs: SetupIntegrationInstall[] = [];
          for (const install of message.installs) {
            if (
              install &&
              (install.target === 'claude' ||
                install.target === 'opencode' ||
                install.target === 'codex') &&
              (install.scope === 'project' || install.scope === 'home')
            ) {
              installs.push({ target: install.target, scope: install.scope });
            }
          }
          finish({
            addGitignoreEntry: message.addGitignoreEntry,
            integrationInstalls: installs,
          });
          return;
        }
        finish(undefined);
      });

      panel.onDidDispose(() => {
        finish(undefined);
      });
    });
  }

  private async handleSetupAgentIntegration(): Promise<void> {
    try {
      if (this.context.extensionMode === vscode.ExtensionMode.Test) {
        const result = runSetupAgentIntegration(this.projectRoot, {
          cliSourceDir: path.resolve(this.context.extensionPath, '..', 'cli'),
          addGitignoreEntry: true,
          integrationTargets: [],
        });
        void result;
        return;
      }

      const setupPlan = await this.promptForSetupPlan();
      if (setupPlan === undefined) {
        return;
      }
      const { addGitignoreEntry, integrationInstalls } = setupPlan;

      const integrationTargets = integrationInstalls.map((install) => install.target);

      const result = runSetupAgentIntegration(this.projectRoot, {
        cliSourceDir: path.resolve(this.context.extensionPath, '..', 'cli'),
        addGitignoreEntry,
        integrationTargets,
        integrationInstalls,
      });

      const summary: string[] = [];
      summary.push('.feedback scaffolding ready');
      summary.push('CLI deployed to .feedback/bin');
      if (result.gitignoreSkipped) {
        summary.push('.gitignore unchanged');
      } else if (result.gitignoreUpdated) {
        summary.push('.gitignore updated');
      } else {
        summary.push('.gitignore already configured');
      }

      if (result.integrationTargetsRequested.length === 0) {
        summary.push('agent integrations skipped');
      } else {
        summary.push(
          `integrations requested: ${this.formatIntegrationTargets(
            result.integrationTargetsRequested
          )}`
        );
        summary.push(
          `install plan: ${this.formatIntegrationInstalls(
            result.integrationInstallsRequested
          )}`
        );
        if (result.skillsWritten.length > 0) {
          summary.push(`skills written (${result.skillsWritten.length})`);
        }
        if (result.skillsWritten.length === 0) {
          summary.push('selected integrations already up to date');
        }
      }

      vscode.window.showInformationMessage(
        `Feedback Loop setup complete: ${summary.join(', ')}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Feedback setup failed: ${message}`);
    }
  }

  private async promptForUninstallPlan(): Promise<
    { removeFeedbackDir: boolean; removeGitignoreEntry: boolean } | undefined
  > {
    interface UninstallOption extends vscode.QuickPickItem {
      removeFeedbackDir: boolean;
      removeGitignoreEntry: boolean;
    }

    const choices: UninstallOption[] = [
      {
        label: 'Full uninstall',
        description: 'Remove .feedback data, deployed CLI, tracked skills, and .gitignore entry',
        removeFeedbackDir: true,
        removeGitignoreEntry: true,
      },
      {
        label: 'Skills only',
        description: 'Remove tracked skills and keep .feedback data in this workspace',
        removeFeedbackDir: false,
        removeGitignoreEntry: false,
      },
    ];

    const selected = await vscode.window.showQuickPick(choices, {
      placeHolder: 'Choose what Feedback uninstall should remove',
      ignoreFocusOut: true,
    });
    if (!selected) {
      return undefined;
    }

    const confirm = await vscode.window.showWarningMessage(
      selected.removeFeedbackDir
        ? 'This will remove Feedback Loop data and uninstall tracked skills. Continue?'
        : 'This will uninstall tracked skills and keep .feedback data. Continue?',
      { modal: true },
      'Uninstall'
    );

    if (confirm !== 'Uninstall') {
      return undefined;
    }

    return {
      removeFeedbackDir: selected.removeFeedbackDir,
      removeGitignoreEntry: selected.removeGitignoreEntry,
    };
  }

  private async handleUninstallAgentIntegration(): Promise<void> {
    try {
      if (this.context.extensionMode === vscode.ExtensionMode.Test) {
        runUninstallAgentIntegration(this.projectRoot, {
          removeFeedbackDir: true,
          removeGitignoreEntry: true,
        });
        this.reloadFromStore();
        return;
      }

      const uninstallPlan = await this.promptForUninstallPlan();
      if (uninstallPlan === undefined) {
        return;
      }

      const result = runUninstallAgentIntegration(this.projectRoot, uninstallPlan);
      this.reloadFromStore();

      if (result.feedbackDirRemoved) {
        await this.context.workspaceState.update('feedback-loop.setupPromptShown', false);
      }

      const summary: string[] = [];
      if (result.feedbackDirRemoved) {
        summary.push('.feedback removed');
      } else if (uninstallPlan.removeFeedbackDir && result.feedbackDirAbsent) {
        summary.push('.feedback already absent');
      } else {
        summary.push('.feedback retained');
      }

      if (result.gitignoreSkipped) {
        summary.push('.gitignore unchanged');
      } else if (result.gitignoreUpdated) {
        summary.push('.gitignore updated');
      } else {
        summary.push('.gitignore already clean');
      }

      if (result.skillsRemoved.length > 0) {
        summary.push(`skills removed (${result.skillsRemoved.length})`);
      } else if (result.trackedSkillInstalls.length > 0) {
        summary.push('tracked skills already absent');
      } else {
        summary.push('no tracked skills found');
      }

      if (result.fallbackDetectionUsed) {
        summary.push('used fallback skill detection');
      }

      vscode.window.showInformationMessage(
        `Feedback Loop uninstall complete: ${summary.join(', ')}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Feedback uninstall failed: ${message}`);
    }
  }

  private async handleShowAllComments(): Promise<void> {
    type VisibilityQuickPickItem = vscode.QuickPickItem & {
      key: 'showResolved' | 'showStale';
    };

    const current = this.commentVisibilityFilter;
    const options: VisibilityQuickPickItem[] = [
      {
        key: 'showResolved',
        label: 'Show resolved',
        description: 'Include workflow-resolved threads in the tree and comments panel',
        picked: current.showResolved,
      },
      {
        key: 'showStale',
        label: 'Show stale',
        description: 'Include stale-anchor threads in the tree and comments panel',
        picked: current.showStale,
      },
    ];

    const selected = await vscode.window.showQuickPick(options, {
      canPickMany: true,
      placeHolder: 'Toggle visibility checkboxes for Feedback comments',
      ignoreFocusOut: true,
    });
    if (!selected) {
      return;
    }

    const next: CommentVisibilityFilter = {
      showResolved: selected.some((item) => item.key === 'showResolved'),
      showStale: selected.some((item) => item.key === 'showStale'),
    };

    this.commentVisibilityFilter = next;
    this.commentsTreeProvider.setVisibilityFilter(next);
    this.reloadFromStore();

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

    this.applyTreeThreadState(commentId, true);
  }

  private handleToggleCommentThreadFromTree(arg?: unknown): void {
    const commentId = this.getCommentIdFromTreeCommandArg(arg);
    if (!commentId) {
      vscode.window.showWarningMessage('Could not identify a comment thread to toggle.');
      return;
    }
    this.toggleSingleThreadCollapse(commentId);
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
      if (
        comment.workflowState !== 'open' ||
        comment.anchorState !== 'anchored' ||
        comment.file !== relativePath
      ) {
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

  private isCommentVisible(comment: FeedbackComment): boolean {
    if (
      !this.commentVisibilityFilter.showResolved &&
      comment.workflowState === 'resolved'
    ) {
      return false;
    }
    if (!this.commentVisibilityFilter.showStale && comment.anchorState === 'stale') {
      return false;
    }
    return true;
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

    // Build a set of visible comment IDs in the store for diffing
    const visibleIds = new Set(
      store.comments.filter((comment) => this.isCommentVisible(comment)).map((c) => c.id)
    );

    // Remove threads for comments that no longer exist in the store
    for (const [commentId, thread] of this.threadMap) {
      if (!visibleIds.has(commentId)) {
        thread.dispose();
        this.threadMap.delete(commentId);
      }
    }

    // Update existing threads and create new ones
    for (const comment of store.comments) {
      if (!this.isCommentVisible(comment)) {
        continue;
      }
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

    this.applyThreadPresentation(thread, comment);

    // Update range if anchor changed (will matter in Phase 3)
    const newRange = this.buildStoredAnchorRange(
      comment.anchor.startLine,
      comment.anchor.endLine
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
      if (!this.isCommentVisible(comment)) {
        continue;
      }
      this.createThreadFromStore(comment);
    }
  }

  private createThreadFromStore(comment: FeedbackComment): void {
    const fileUri = vscode.Uri.file(
      path.join(this.projectRoot, comment.file)
    );
    const range = this.buildStoredAnchorRange(
      comment.anchor.startLine,
      comment.anchor.endLine
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
    this.applyThreadPresentation(thread, comment);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;

    this.threadMap.set(comment.id, thread);
  }

  // --- Helpers ---

  private buildCommentingRanges(document: vscode.TextDocument): vscode.Range[] {
    if (document.lineCount === 0) {
      return [];
    }

    // Keep range anchors zero-length at line starts to avoid duplicate
    // glyphs on visually wrapped lines.
    if (document.lineCount <= MAX_PER_LINE_COMMENTING_RANGES) {
      const ranges: vscode.Range[] = [];
      for (let line = 0; line < document.lineCount; line++) {
        ranges.push(new vscode.Range(line, 0, line, 0));
      }
      return ranges;
    }

    // Fallback for very large files.
    return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
  }

  private buildDocumentLineRange(
    document: vscode.TextDocument,
    startLine: number,
    endLine: number
  ): vscode.Range {
    const clampedStart = Math.max(0, Math.min(startLine, document.lineCount - 1));
    const clampedEnd = Math.max(clampedStart, Math.min(endLine, document.lineCount - 1));
    return new vscode.Range(clampedStart, 0, clampedEnd, 0);
  }

  private buildStoredAnchorRange(startLine: number, endLine: number): vscode.Range {
    const start = Math.max(0, startLine - 1);
    const end = Math.max(start, endLine - 1);
    return new vscode.Range(start, 0, end, 0);
  }

  private applyTreeThreadState(commentId: string, shouldExpand: boolean): void {
    const targetThread = this.threadMap.get(commentId);
    if (!targetThread) {
      return;
    }

    if (!shouldExpand) {
      targetThread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      return;
    }

    // Keep tree navigation deterministic: selecting a comment opens only that
    // thread and collapses the rest.
    for (const [id, thread] of this.threadMap) {
      if (id === commentId) continue;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    }

    targetThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  private toggleSingleThreadCollapse(commentId: string): void {
    const thread = this.threadMap.get(commentId);
    if (!thread) {
      return;
    }
    this.toggleThreadCollapse(thread);
  }

  private toggleThreadCollapse(thread: vscode.CommentThread): void {
    const isExpanded =
      thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded;
    thread.collapsibleState = isExpanded
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
  }

  private getCommentIdFromTreeCommandArg(arg?: unknown): string | undefined {
    if (typeof arg === 'string') {
      return arg;
    }
    if (!arg || typeof arg !== 'object') {
      return undefined;
    }
    const candidate = arg as {
      kind?: unknown;
      comment?: { id?: unknown };
      commentId?: unknown;
    };
    if (typeof candidate.commentId === 'string') {
      return candidate.commentId;
    }
    if (
      candidate.kind === 'comment' &&
      candidate.comment &&
      typeof candidate.comment.id === 'string'
    ) {
      return candidate.comment.id;
    }
    return undefined;
  }

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
    comment: FeedbackComment
  ): void {
    const statusText = statusTagText(comment);
    thread.label = statusText.length > 0 ? `Feedback • ${statusText}` : 'Feedback';
    thread.canReply = comment.workflowState !== 'resolved';

    if (comment.workflowState === 'resolved') {
      thread.state = vscode.CommentThreadState.Resolved;
      thread.contextValue = 'feedback-thread-resolved';
      return;
    }

    thread.state = vscode.CommentThreadState.Unresolved;
    thread.contextValue = 'feedback-thread-open';
  }

  /**
   * Write to store with watcher suppression to avoid re-reading our own writes.
   */
  private writeStoreSuppress(store: FeedbackStore): void {
    this.suppressWatcher = true;
    try {
      this.commentsTreeProvider.setStore(store);
      writeStore(this.projectRoot, store);
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        (err as { code?: string }).code === 'ESTORECONFLICT'
      ) {
        // Another writer updated the store between read and write. Reload and
        // ask the user to retry rather than silently overwriting.
        this.reloadFromStore();
        vscode.window.showWarningMessage(
          'Feedback store changed while saving. Please retry your last action.'
        );
        return;
      }
      throw err;
    } finally {
      // Re-enable watcher after a short delay to let the file event settle
      setTimeout(() => {
        this.suppressWatcher = false;
      }, 500);
    }
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
      'feedback-loop.uninstallAgentIntegration',
      'feedback-loop.showAllComments',
      'feedback-loop.archiveResolved',
      'feedback-loop.reconcileAll',
      'feedback-loop.toggleCommentThreadFromTree',
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
