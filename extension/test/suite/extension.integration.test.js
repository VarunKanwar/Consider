const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

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

suite('Feedback Loop Extension Host', () => {
  setup(async () => {
    const root = workspaceRoot();
    removeIfExists(path.join(root, '.feedback'));
    removeIfExists(path.join(root, '.claude'));
    removeIfExists(path.join(root, '.opencode'));
    removeIfExists(path.join(root, '.codex'));
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

    const sampleUri = vscode.Uri.file(path.join(root, 'src', 'sample.ts'));
    const doc = await vscode.workspace.openTextDocument(sampleUri);
    await vscode.window.showTextDocument(doc);

    const controller = vscode.comments.createCommentController(
      'feedback-loop-test-controller',
      'Feedback Loop Test'
    );
    const thread = controller.createCommentThread(
      sampleUri,
      new vscode.Range(1, 0, 1, 0),
      []
    );

    await vscode.commands.executeCommand('feedback-loop.addComment', {
      text: 'Integration test comment',
      thread,
    });

    controller.dispose();

    const store = readJson(path.join(root, '.feedback', 'store.json'));
    const inserted = store.comments.find((comment) => comment.body === 'Integration test comment');
    assert.ok(inserted, 'Expected inserted comment in store.');
    assert.equal(inserted.status, 'open');
    assert.equal(inserted.file, 'src/sample.ts');
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
