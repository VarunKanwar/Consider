export {};
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = process.cwd();
const CLI_PATH = path.join(ROOT, 'cli', 'consider-cli.js');
const extensionStore = require(path.join(ROOT, 'extension', 'out', 'store.js'));

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consider-extension-store-test-'));
  fs.mkdirSync(path.join(dir, '.consider'), { recursive: true });
  return dir;
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeComment(id: string, body: string) {
  return {
    id,
    file: 'src/main.ts',
    anchor: {
      startLine: 1,
      endLine: 1,
      targetContent: 'const value = 1;',
    },
    workflowState: 'open',
    anchorState: 'anchored',
    createdAt: '2025-02-15T10:00:00.000Z',
    author: 'human',
    body,
    thread: [],
  };
}

function readStoreFile(projectRoot: string) {
  return JSON.parse(
    fs.readFileSync(path.join(projectRoot, '.consider', 'store.json'), 'utf-8')
  );
}

function runCli(args: string[], cwd: string): string {
  return execFileSync('node', [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 5000,
  });
}

function runCliAsync(
  args: string[],
  cwd: string
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_PATH, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });
}

describe('extension store runtime wrapper', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTmpProject();
  });

  afterEach(() => {
    cleanup(projectRoot);
  });

  it('surfaces stale snapshot conflicts through writeStore', () => {
    const initial = extensionStore.emptyStore();
    initial.comments.push(makeComment('c_stale', 'Initial comment'));
    extensionStore.writeStore(projectRoot, initial);

    const staleSnapshot = extensionStore.readStore(projectRoot);
    runCli(['reply', 'c_stale', '--message', 'CLI update'], projectRoot);

    staleSnapshot.comments.push(makeComment('c_new', 'Extension stale write'));

    assert.throws(
      () => extensionStore.writeStore(projectRoot, staleSnapshot),
      (error: { code?: string } | null | undefined) =>
        Boolean(error && error.code === 'ESTORECONFLICT')
    );
  });

  it('preserves both extension and CLI updates during concurrent writes', async () => {
    const initial = extensionStore.emptyStore();
    initial.comments.push(makeComment('c_cli', 'CLI target'));
    initial.comments.push(makeComment('c_ext', 'Extension target'));
    extensionStore.writeStore(projectRoot, initial);

    const cliReply = runCliAsync(
      ['reply', 'c_cli', '--message', 'Concurrent CLI reply'],
      projectRoot
    );
    const extensionUpdate = Promise.resolve().then(() => {
      extensionStore.mutateStore(
        projectRoot,
        (store: { comments: Array<{ id: string; thread: unknown[] }> }) => {
          const comment = store.comments.find((entry) => entry.id === 'c_ext');
          if (!comment) {
            throw new Error('Expected extension target comment to exist');
          }
          comment.thread.push({
            id: extensionStore.generateReplyId(),
            author: 'human',
            body: 'Concurrent extension reply',
            createdAt: new Date().toISOString(),
          });
          return true;
        }
      );
    });

    const [cliResult] = await Promise.all([cliReply, extensionUpdate]);
    assert.equal(cliResult.code, 0, cliResult.stderr);

    const storeAfter = readStoreFile(projectRoot);
    const cliComment = storeAfter.comments.find(
      (comment: { id: string }) => comment.id === 'c_cli'
    );
    const extensionComment = storeAfter.comments.find(
      (comment: { id: string }) => comment.id === 'c_ext'
    );
    assert.ok(cliComment, 'Expected CLI target comment to exist');
    assert.ok(extensionComment, 'Expected extension target comment to exist');

    assert.ok(
      cliComment.thread.some(
        (reply: { body: string }) => reply.body === 'Concurrent CLI reply'
      )
    );
    assert.ok(
      extensionComment.thread.some(
        (reply: { body: string }) => reply.body === 'Concurrent extension reply'
      )
    );
  });
});
