const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  runSetupAgentIntegration,
  runUninstallAgentIntegration,
} = require(path.join(__dirname, '..', '..', 'out', 'setup.js'));
const CLI_SOURCE_DIR = path.resolve(__dirname, '..', '..', '..', 'cli');

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  assert.ok(folders.length > 0, 'Expected an open workspace for extension host tests.');
  return folders[0].uri.fsPath;
}

function removeIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(targetPath);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function commentBodyToString(comment) {
  if (!comment) {
    return '';
  }
  if (typeof comment.body === 'string') {
    return comment.body;
  }
  if (comment.body && typeof comment.body.value === 'string') {
    return comment.body.value;
  }
  return String(comment.body || '');
}

async function waitFor(predicate, description, timeoutMs = 5000, intervalMs = 50) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const matched = await Promise.resolve(predicate());
    if (matched) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

async function addCommentViaPayload(root, text, controllers) {
  const sampleUri = vscode.Uri.file(path.join(root, 'src', 'sample.ts'));
  const doc = await vscode.workspace.openTextDocument(sampleUri);
  await vscode.window.showTextDocument(doc);

  const controller = vscode.comments.createCommentController(
    `consider-test-controller-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    'Consider Test'
  );
  controllers.push(controller);
  const thread = controller.createCommentThread(
    sampleUri,
    new vscode.Range(1, 0, 1, 0),
    []
  );

  await vscode.commands.executeCommand('consider.addComment', {
    text,
    thread,
  });

  const storePath = path.join(root, '.consider', 'store.json');
  const store = readJson(storePath);
  const inserted = store.comments.find((comment) => comment.body === text);
  assert.ok(inserted, 'Expected inserted comment in store.');

  return {
    thread,
    commentId: inserted.id,
    storePath,
    sampleUri,
  };
}

suite('Consider Extension Host', () => {
  /** @type {vscode.CommentController[]} */
  let controllers;

  setup(() => {
    controllers = [];
  });

  teardown(() => {
    for (const controller of controllers) {
      controller.dispose();
    }
    controllers = [];
  });

  setup(async () => {
    const root = workspaceRoot();
    removeIfExists(path.join(root, '.consider'));
    removeIfExists(path.join(root, '.claude'));
    removeIfExists(path.join(root, '.opencode'));
    removeIfExists(path.join(root, '.codex'));
    removeIfExists(path.join(root, 'fake-home'));
    removeIfExists(path.join(root, '.gitignore'));

    const samplePath = path.join(root, 'src', 'sample.ts');
    fs.mkdirSync(path.dirname(samplePath), { recursive: true });
    fs.writeFileSync(
      samplePath,
      [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );
  });

  test('setup command scaffolds feedback integration files', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('consider.setupAgentIntegration');

    assert.ok(fs.existsSync(path.join(root, '.consider', 'store.json')));
    assert.ok(fs.existsSync(path.join(root, '.consider', 'config.json')));
    assert.ok(fs.existsSync(path.join(root, '.consider', 'bin', 'consider-cli')));
    assert.ok(fs.existsSync(path.join(root, '.consider', 'bin', 'consider-cli.js')));
    assert.ok(fs.existsSync(path.join(root, '.consider', 'bin', 'consider-cli.cjs')));
    assert.ok(fs.existsSync(path.join(root, '.consider', 'bin', 'package.json')));
    assert.ok(fs.existsSync(path.join(root, '.consider', 'shared', 'store.js')));
    assert.ok(fs.existsSync(path.join(root, '.consider', 'shared', 'reconcile.js')));
    assert.ok(fs.existsSync(path.join(root, '.consider', 'shared', 'package.json')));
    assert.ok(fs.readFileSync(path.join(root, '.gitignore'), 'utf-8').includes('.consider/'));
    assert.ok(!fs.existsSync(path.join(root, '.claude')));
    assert.ok(!fs.existsSync(path.join(root, '.opencode')));
    assert.ok(!fs.existsSync(path.join(root, '.codex')));
  });

  test('commenting ranges are one zero-length anchor per source line', async () => {
    const root = workspaceRoot();
    const samplePath = path.join(root, 'src', 'sample.ts');
    fs.writeFileSync(
      samplePath,
      [
        "const veryLongLine = 'this line is intentionally long to wrap in the editor viewport and exercise gutter range behavior for comment affordances';",
        'const secondLine = 2;',
        '',
      ].join('\n'),
      'utf-8'
    );

    const sampleUri = vscode.Uri.file(samplePath);
    const doc = await vscode.workspace.openTextDocument(sampleUri);
    await vscode.window.showTextDocument(doc);

    const ranges = await vscode.commands.executeCommand('consider.debug.commentingRanges');
    assert.ok(Array.isArray(ranges));
    assert.equal(ranges.length, doc.lineCount);

    ranges.forEach((range, line) => {
      assert.equal(range.startLine, line);
      assert.equal(range.endLine, line);
      assert.equal(range.startCharacter, 0);
      assert.equal(range.endCharacter, 0);
    });
  });

  test('add comment command writes a store record from command payload path', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('consider.setupAgentIntegration');
    const { commentId } = await addCommentViaPayload(
      root,
      'Integration test comment',
      controllers
    );
    const store = readJson(path.join(root, '.consider', 'store.json'));
    const inserted = store.comments.find((comment) => comment.id === commentId);
    assert.ok(inserted, 'Expected inserted comment to still exist in store.');
    assert.equal(inserted.workflowState, 'open');
    assert.equal(inserted.anchorState, 'anchored');
    assert.equal(inserted.file, 'src/sample.ts');
  });

  test('renders external agent replies via store watcher updates', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('consider.setupAgentIntegration');
    const { thread, commentId, storePath } = await addCommentViaPayload(
      root,
      'Watcher integration test comment',
      controllers
    );

    const store = readJson(storePath);
    const comment = store.comments.find((entry) => entry.id === commentId);
    assert.ok(comment, 'Expected test comment in store before watcher update.');

    // Extension write suppression is 500ms; wait so this write is treated as external.
    await new Promise((resolve) => setTimeout(resolve, 700));

    comment.thread.push({
      id: 'r_agent_watcher_1',
      author: 'agent',
      body: 'Agent watcher reply',
      createdAt: new Date().toISOString(),
    });
    writeJson(storePath, store);

    await waitFor(
      () => {
        const comments = thread.comments || [];
        return (
          comments.length === 2 &&
          comments[1] &&
          comments[1].author &&
          comments[1].author.name === 'Agent'
        );
      },
      'thread to include externally-written agent reply'
    );

    const updatedComments = thread.comments || [];
    assert.equal(updatedComments.length, 2);
    assert.ok(
      commentBodyToString(updatedComments[1]).includes('Agent watcher reply'),
      'Expected updated thread reply body to include watcher reply text.'
    );
  });

  test('resolve and reopen commands update store and thread state', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('consider.setupAgentIntegration');
    const { thread, commentId } = await addCommentViaPayload(
      root,
      'Resolve transition test comment',
      controllers
    );

    await vscode.commands.executeCommand('consider.resolveThread', thread);
    let store = readJson(path.join(root, '.consider', 'store.json'));
    let comment = store.comments.find((entry) => entry.id === commentId);
    assert.ok(comment, 'Expected comment after resolve command.');
    assert.equal(comment.workflowState, 'resolved');
    assert.equal(thread.state, vscode.CommentThreadState.Resolved);

    await vscode.commands.executeCommand('consider.replyToComment', {
      thread,
      text: 'should be blocked while resolved',
    });
    store = readJson(path.join(root, '.consider', 'store.json'));
    comment = store.comments.find((entry) => entry.id === commentId);
    assert.ok(comment, 'Expected comment after blocked reply.');
    assert.equal(comment.thread.length, 0);

    await vscode.commands.executeCommand('consider.unresolveThread', thread);
    store = readJson(path.join(root, '.consider', 'store.json'));
    comment = store.comments.find((entry) => entry.id === commentId);
    assert.ok(comment, 'Expected comment after reopen command.');
    assert.equal(comment.workflowState, 'open');
    assert.equal(thread.state, vscode.CommentThreadState.Unresolved);
  });

  test('copy thread ID command writes threadID token to clipboard', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('consider.setupAgentIntegration');
    const { thread, commentId } = await addCommentViaPayload(
      root,
      'Clipboard copy thread id test comment',
      controllers
    );

    await vscode.commands.executeCommand('consider.copyThreadId', thread);
    const clipboardValue = await vscode.env.clipboard.readText();
    assert.equal(clipboardValue, `threadID: ${commentId}`);
  });

  test('tree comment selection opens and expands only the selected thread', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('consider.setupAgentIntegration');

    const first = await addCommentViaPayload(
      root,
      'Tree toggle first comment',
      controllers
    );
    const second = await addCommentViaPayload(
      root,
      'Tree toggle second comment',
      controllers
    );

    assert.equal(
      first.thread.collapsibleState,
      vscode.CommentThreadCollapsibleState.Collapsed
    );
    assert.equal(
      second.thread.collapsibleState,
      vscode.CommentThreadCollapsibleState.Collapsed
    );

    await vscode.commands.executeCommand(
      'consider.openCommentFromTree',
      first.commentId
    );
    await waitFor(
      () =>
        first.thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded,
      'first thread to expand from tree selection'
    );
    assert.equal(
      second.thread.collapsibleState,
      vscode.CommentThreadCollapsibleState.Collapsed
    );

    await vscode.commands.executeCommand(
      'consider.openCommentFromTree',
      first.commentId
    );
    await waitFor(
      () =>
        first.thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded,
      'first thread to remain stable after second tree selection'
    );
  });

  test('tree inline toggle command collapses and expands a single thread', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('consider.setupAgentIntegration');

    const first = await addCommentViaPayload(
      root,
      'Tree inline toggle first comment',
      controllers
    );
    const second = await addCommentViaPayload(
      root,
      'Tree inline toggle second comment',
      controllers
    );

    await vscode.commands.executeCommand('consider.openCommentFromTree', first.commentId);
    await waitFor(
      () =>
        first.thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded,
      'first thread to be expanded before toggle'
    );
    assert.equal(
      second.thread.collapsibleState,
      vscode.CommentThreadCollapsibleState.Collapsed
    );

    await vscode.commands.executeCommand('consider.toggleCommentThreadFromTree', {
      kind: 'comment',
      comment: { id: first.commentId },
    });
    await waitFor(
      () =>
        first.thread.collapsibleState === vscode.CommentThreadCollapsibleState.Collapsed,
      'first thread to collapse from inline toggle'
    );
    assert.equal(
      second.thread.collapsibleState,
      vscode.CommentThreadCollapsibleState.Collapsed
    );

    await vscode.commands.executeCommand('consider.toggleCommentThreadFromTree', {
      kind: 'comment',
      comment: { id: first.commentId },
    });
    await waitFor(
      () =>
        first.thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded,
      'first thread to expand from inline toggle'
    );
    assert.equal(
      second.thread.collapsibleState,
      vscode.CommentThreadCollapsibleState.Collapsed
    );
  });

  test('supports skills-only and full uninstall paths', async () => {
    const root = workspaceRoot();
    const fakeHome = path.join(root, 'fake-home');
    fs.mkdirSync(fakeHome, { recursive: true });

    runSetupAgentIntegration(root, {
      cliSourceDir: CLI_SOURCE_DIR,
      integrationTargets: ['codex'],
      integrationInstalls: [{ target: 'codex', scope: 'project' }],
      homeDir: fakeHome,
    });

    const codexSkill = path.join(root, '.codex', 'skills', 'consider', 'SKILL.md');
    assert.ok(fs.existsSync(path.join(root, '.consider', 'store.json')));
    assert.ok(fs.existsSync(codexSkill));

    const skillsOnly = runUninstallAgentIntegration(root, {
      removeConsiderDir: false,
      removeGitignoreEntry: false,
      homeDir: fakeHome,
    });
    assert.equal(skillsOnly.considerDirRemoved, false);
    assert.ok(fs.existsSync(path.join(root, '.consider', 'store.json')));
    assert.ok(!fs.existsSync(codexSkill));

    runSetupAgentIntegration(root, {
      cliSourceDir: CLI_SOURCE_DIR,
      integrationTargets: ['claude'],
      integrationInstalls: [{ target: 'claude', scope: 'project' }],
      homeDir: fakeHome,
    });
    const claudeSkill = path.join(root, '.claude', 'skills', 'consider', 'SKILL.md');
    assert.ok(fs.existsSync(claudeSkill));

    await vscode.commands.executeCommand('consider.uninstallAgentIntegration');
    assert.ok(!fs.existsSync(path.join(root, '.consider')));
    assert.ok(!fs.existsSync(claudeSkill));
  });

  test('updates stale and orphaned status after file edits and deletion', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('consider.setupAgentIntegration');
    const { thread, commentId } = await addCommentViaPayload(
      root,
      'Stale-orphan integration test comment',
      controllers
    );
    const samplePath = path.join(root, 'src', 'sample.ts');

    fs.writeFileSync(
      samplePath,
      ['const alpha = 1;', 'const beta = alpha * 2;', 'export { beta };', ''].join('\n'),
      'utf-8'
    );

    await vscode.commands.executeCommand('consider.reconcileAll');
    let store = readJson(path.join(root, '.consider', 'store.json'));
    let comment = store.comments.find((entry) => entry.id === commentId);
    assert.ok(comment, 'Expected comment after stale transition.');
    assert.equal(comment.anchorState, 'stale');
    await waitFor(
      () =>
        thread.contextValue === 'consider-thread-open-stale' &&
        typeof thread.label === 'string' &&
        thread.label.includes('Stale'),
      'thread stale status presentation'
    );

    fs.unlinkSync(samplePath);
    await vscode.commands.executeCommand('consider.reconcileAll');
    store = readJson(path.join(root, '.consider', 'store.json'));
    comment = store.comments.find((entry) => entry.id === commentId);
    assert.ok(comment, 'Expected comment after orphan transition.');
    assert.equal(comment.anchorState, 'orphaned');
    await waitFor(
      () =>
        thread.contextValue === 'consider-thread-open-orphaned' &&
        typeof thread.label === 'string' &&
        thread.label.includes('Orphaned'),
      'thread orphaned status presentation'
    );
  });

  test('archive resolved command moves resolved comments into archive', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('consider.setupAgentIntegration');

    const storePath = path.join(root, '.consider', 'store.json');
    const store = readJson(storePath);
    store.comments = [
      {
        id: 'c_open_1',
        file: 'src/sample.ts',
        anchor: { startLine: 1, endLine: 1 },
        workflowState: 'open',
        anchorState: 'anchored',
        createdAt: '2025-02-15T10:00:00.000Z',
        author: 'human',
        body: 'Open comment',
        thread: [],
      },
      {
        id: 'c_resolved_1',
        file: 'src/sample.ts',
        anchor: { startLine: 2, endLine: 2 },
        workflowState: 'resolved',
        anchorState: 'anchored',
        createdAt: '2025-02-15T10:00:00.000Z',
        author: 'human',
        body: 'Resolved comment',
        thread: [],
      },
    ];
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf-8');

    await vscode.commands.executeCommand('consider.archiveResolved');

    const nextStore = readJson(storePath);
    assert.equal(nextStore.comments.length, 1);
    assert.equal(nextStore.comments[0].id, 'c_open_1');

    const archive = readJson(path.join(root, '.consider', 'archive.json'));
    const archivedResolved = archive.comments.find(
      (entry) => entry.comment.id === 'c_resolved_1'
    );
    assert.ok(archivedResolved, 'Expected resolved comment to be archived.');
  });
});
