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
    if (predicate()) {
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
    `feedback-loop-test-controller-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    'Feedback Loop Test'
  );
  controllers.push(controller);
  const thread = controller.createCommentThread(
    sampleUri,
    new vscode.Range(1, 0, 1, 0),
    []
  );

  await vscode.commands.executeCommand('feedback-loop.addComment', {
    text,
    thread,
  });

  const storePath = path.join(root, '.feedback', 'store.json');
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

suite('Feedback Loop Extension Host', () => {
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
    removeIfExists(path.join(root, '.feedback'));
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
    await vscode.commands.executeCommand('feedback-loop.setupAgentIntegration');

    assert.ok(fs.existsSync(path.join(root, '.feedback', 'store.json')));
    assert.ok(fs.existsSync(path.join(root, '.feedback', 'config.json')));
    assert.ok(fs.existsSync(path.join(root, '.feedback', 'bin', 'feedback-cli')));
    assert.ok(fs.existsSync(path.join(root, '.feedback', 'bin', 'feedback-cli.js')));
    assert.ok(fs.existsSync(path.join(root, '.feedback', 'bin', 'feedback-cli.cjs')));
    assert.ok(fs.existsSync(path.join(root, '.feedback', 'bin', 'package.json')));
    assert.ok(fs.existsSync(path.join(root, '.feedback', 'shared', 'store.js')));
    assert.ok(fs.existsSync(path.join(root, '.feedback', 'shared', 'reconcile.js')));
    assert.ok(fs.existsSync(path.join(root, '.feedback', 'shared', 'package.json')));
    assert.ok(fs.readFileSync(path.join(root, '.gitignore'), 'utf-8').includes('.feedback/'));
    assert.ok(!fs.existsSync(path.join(root, '.claude')));
    assert.ok(!fs.existsSync(path.join(root, '.opencode')));
    assert.ok(!fs.existsSync(path.join(root, '.codex')));
  });

  test('add comment command writes a store record from command payload path', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('feedback-loop.setupAgentIntegration');
    const { commentId } = await addCommentViaPayload(
      root,
      'Integration test comment',
      controllers
    );
    const store = readJson(path.join(root, '.feedback', 'store.json'));
    const inserted = store.comments.find((comment) => comment.id === commentId);
    assert.ok(inserted, 'Expected inserted comment to still exist in store.');
    assert.equal(inserted.status, 'open');
    assert.equal(inserted.file, 'src/sample.ts');
  });

  test('renders external agent replies via store watcher updates', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('feedback-loop.setupAgentIntegration');
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
    await vscode.commands.executeCommand('feedback-loop.setupAgentIntegration');
    const { thread, commentId } = await addCommentViaPayload(
      root,
      'Resolve transition test comment',
      controllers
    );

    await vscode.commands.executeCommand('feedback-loop.resolveThread', thread);
    let store = readJson(path.join(root, '.feedback', 'store.json'));
    let comment = store.comments.find((entry) => entry.id === commentId);
    assert.ok(comment, 'Expected comment after resolve command.');
    assert.equal(comment.status, 'resolved');
    assert.equal(thread.state, vscode.CommentThreadState.Resolved);

    await vscode.commands.executeCommand('feedback-loop.unresolveThread', thread);
    store = readJson(path.join(root, '.feedback', 'store.json'));
    comment = store.comments.find((entry) => entry.id === commentId);
    assert.ok(comment, 'Expected comment after reopen command.');
    assert.equal(comment.status, 'open');
    assert.equal(thread.state, vscode.CommentThreadState.Unresolved);
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

    const codexSkill = path.join(root, '.codex', 'skills', 'feedback-loop', 'SKILL.md');
    assert.ok(fs.existsSync(path.join(root, '.feedback', 'store.json')));
    assert.ok(fs.existsSync(codexSkill));

    const skillsOnly = runUninstallAgentIntegration(root, {
      removeFeedbackDir: false,
      removeGitignoreEntry: false,
      homeDir: fakeHome,
    });
    assert.equal(skillsOnly.feedbackDirRemoved, false);
    assert.ok(fs.existsSync(path.join(root, '.feedback', 'store.json')));
    assert.ok(!fs.existsSync(codexSkill));

    runSetupAgentIntegration(root, {
      cliSourceDir: CLI_SOURCE_DIR,
      integrationTargets: ['claude'],
      integrationInstalls: [{ target: 'claude', scope: 'project' }],
      homeDir: fakeHome,
    });
    const claudeSkill = path.join(root, '.claude', 'skills', 'feedback-loop', 'SKILL.md');
    assert.ok(fs.existsSync(claudeSkill));

    await vscode.commands.executeCommand('feedback-loop.uninstallAgentIntegration');
    assert.ok(!fs.existsSync(path.join(root, '.feedback')));
    assert.ok(!fs.existsSync(claudeSkill));
  });

  test('updates stale and orphaned status after file edits and deletion', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('feedback-loop.setupAgentIntegration');
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

    await vscode.commands.executeCommand('feedback-loop.reconcileAll');
    let store = readJson(path.join(root, '.feedback', 'store.json'));
    let comment = store.comments.find((entry) => entry.id === commentId);
    assert.ok(comment, 'Expected comment after stale transition.');
    assert.equal(comment.status, 'stale');
    await waitFor(
      () =>
        thread.contextValue === 'feedback-thread-stale' &&
        thread.label === 'Stale Feedback',
      'thread stale status presentation'
    );

    fs.unlinkSync(samplePath);
    await vscode.commands.executeCommand('feedback-loop.reconcileAll');
    store = readJson(path.join(root, '.feedback', 'store.json'));
    comment = store.comments.find((entry) => entry.id === commentId);
    assert.ok(comment, 'Expected comment after orphan transition.');
    assert.equal(comment.status, 'orphaned');
    await waitFor(
      () =>
        thread.contextValue === 'feedback-thread-orphaned' &&
        thread.label === 'Orphaned Feedback',
      'thread orphaned status presentation'
    );
  });

  test('archive resolved command moves resolved comments into archive', async () => {
    const root = workspaceRoot();
    await vscode.commands.executeCommand('feedback-loop.setupAgentIntegration');

    const storePath = path.join(root, '.feedback', 'store.json');
    const store = readJson(storePath);
    store.comments = [
      {
        id: 'c_open_1',
        file: 'src/sample.ts',
        anchor: { startLine: 1, endLine: 1 },
        status: 'open',
        createdAt: '2025-02-15T10:00:00.000Z',
        author: 'human',
        body: 'Open comment',
        thread: [],
      },
      {
        id: 'c_resolved_1',
        file: 'src/sample.ts',
        anchor: { startLine: 2, endLine: 2 },
        status: 'resolved',
        createdAt: '2025-02-15T10:00:00.000Z',
        author: 'human',
        body: 'Resolved comment',
        thread: [],
      },
    ];
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf-8');

    await vscode.commands.executeCommand('feedback-loop.archiveResolved');

    const nextStore = readJson(storePath);
    assert.equal(nextStore.comments.length, 1);
    assert.equal(nextStore.comments[0].id, 'c_open_1');

    const archive = readJson(path.join(root, '.feedback', 'archive.json'));
    const archivedResolved = archive.comments.find(
      (entry) => entry.comment.id === 'c_resolved_1'
    );
    assert.ok(archivedResolved, 'Expected resolved comment to be archived.');
  });
});
