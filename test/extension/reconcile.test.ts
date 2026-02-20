export {};
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = process.cwd();
const sharedReconcile = require(path.join(ROOT, 'shared', 'reconcile.js'));
const extensionReconcile = require(path.join(ROOT, 'extension', 'out', 'reconcile.js'));

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-ext-reconcile-'));
  fs.mkdirSync(path.join(dir, '.consider'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(dir, file, content) {
  const filePath = path.join(dir, file);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function makeComment({
  id,
  file,
  startLine,
  endLine,
  targetContent,
  contextBefore,
  contextAfter,
  workflowState = 'open',
  anchorState = 'anchored',
}) {
  return {
    id,
    file,
    anchor: {
      startLine,
      endLine,
      targetContent,
      contextBefore,
      contextAfter,
      lastAnchorCheck: '2025-01-01T00:00:00.000Z',
    },
    workflowState,
    anchorState,
    createdAt: '2025-02-15T10:00:00.000Z',
    author: 'human',
    body: 'Please update this.',
    thread: [],
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectParity(
  projectRoot,
  storeData,
  options: { force?: boolean; nowIso?: string } | undefined = undefined
) {
  const deterministicNowIso = '2026-02-16T20:00:00.000Z';
  const optionsWithNow = {
    ...(options || {}),
    nowIso: deterministicNowIso,
  };
  const sharedStore = deepClone(storeData);
  const extensionStore = deepClone(storeData);

  const sharedResult = sharedReconcile.reconcileStore(projectRoot, sharedStore, optionsWithNow);
  const extensionResult = extensionReconcile.reconcileStoreForExtension(
    projectRoot,
    extensionStore,
    optionsWithNow
  );

  assert.deepEqual(extensionResult, sharedResult);
  assert.deepEqual(extensionStore, sharedStore);
}

describe('extension reconciliation parity', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('matches shared reconciliation for line insertions', () => {
    writeFile(
      tmpDir,
      'src/example.ts',
      [
        'function run() {',
        '  const x = 1;',
        '  return x;',
        '}',
        '',
      ].join('\n')
    );

    const storeData = {
      version: 1,
      comments: [
        makeComment({
          id: 'c_parity_insert',
          file: 'src/example.ts',
          startLine: 3,
          endLine: 3,
          targetContent: '  return x;',
          contextBefore: ['function run() {', '  const x = 1;'],
          contextAfter: ['}'],
        }),
      ],
    };

    writeFile(
      tmpDir,
      'src/example.ts',
      [
        '// inserted',
        'function run() {',
        '  const x = 1;',
        '  return x;',
        '}',
        '',
      ].join('\n')
    );

    expectParity(tmpDir, storeData);
  });

  it('matches shared reconciliation for stale and orphan outcomes', () => {
    writeFile(tmpDir, 'src/example.ts', 'const one = 1;\n');
    const storeData = {
      version: 1,
      comments: [
        makeComment({
          id: 'c_parity_state',
          file: 'src/example.ts',
          startLine: 1,
          endLine: 1,
          targetContent: 'const one = 1;',
          contextBefore: [],
          contextAfter: [],
        }),
      ],
    };

    writeFile(tmpDir, 'src/example.ts', 'const two = 2;\n');
    expectParity(tmpDir, storeData);

    const orphanCase = deepClone(storeData);
    fs.unlinkSync(path.join(tmpDir, 'src', 'example.ts'));
    expectParity(tmpDir, orphanCase);
  });

  it('matches shared behavior for re-anchoring stale comments without workflow changes', () => {
    writeFile(tmpDir, 'src/example.ts', 'const value = 1;\n');
    const storeData = {
      version: 1,
      comments: [
        makeComment({
          id: 'c_parity_force',
          file: 'src/example.ts',
          startLine: 1,
          endLine: 1,
          targetContent: 'const value = 1;',
          contextBefore: [],
          contextAfter: [],
          workflowState: 'resolved',
          anchorState: 'stale',
        }),
      ],
    };

    expectParity(tmpDir, storeData, { force: false });
  });
});
