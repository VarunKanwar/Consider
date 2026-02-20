export {};
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const reconcile = require(path.join(ROOT, 'shared', 'reconcile.js'));

const CLI_PATH = path.join(ROOT, 'cli', 'consider-cli.js');

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-reconcile-'));
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

function seedStore(dir, comments) {
  fs.writeFileSync(
    path.join(dir, '.consider', 'store.json'),
    JSON.stringify({ version: 1, comments }, null, 2) + '\n',
    'utf-8'
  );
}

function readStoreFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.consider', 'store.json'), 'utf-8'));
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

function run(args, cwd) {
  return execFileSync('node', [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 5000,
  });
}

function runFail(args, cwd) {
  try {
    execFileSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.fail('Expected command to fail');
  } catch (error) {
    return error.stderr;
  }
}

describe('reconcile core', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('re-anchors when lines are inserted above the target', () => {
    writeFile(
      tmpDir,
      'src/example.ts',
      [
        'export function run() {',
        '  const value = 1;',
        '  return value;',
        '}',
        '',
      ].join('\n')
    );

    const comment = makeComment({
      id: 'c_insert',
      file: 'src/example.ts',
      startLine: 3,
      endLine: 3,
      targetContent: '  return value;',
      contextBefore: ['export function run() {', '  const value = 1;'],
      contextAfter: ['}'],
    });
    const storeData = { version: 1, comments: [comment] };

    writeFile(
      tmpDir,
      'src/example.ts',
      [
        '// header',
        'export function run() {',
        '  const value = 1;',
        '  return value;',
        '}',
        '',
      ].join('\n')
    );

    const result = reconcile.reconcileStore(tmpDir, storeData);
    assert.equal(result.checkedComments, 1);
    assert.equal(result.updatedComments, 1);
    assert.equal(storeData.comments[0].anchor.startLine, 4);
    assert.equal(storeData.comments[0].workflowState, 'open');
    assert.equal(storeData.comments[0].anchorState, 'anchored');
    assert.equal((storeData.comments[0].anchor as any).contentHash.length, 8);
  });

  it('uses fuzzy context matching when target content changed', () => {
    writeFile(
      tmpDir,
      'src/example.ts',
      [
        'function build() {',
        '  const token = source();',
        '  return token;',
        '}',
        '',
      ].join('\n')
    );

    const comment = makeComment({
      id: 'c_fuzzy',
      file: 'src/example.ts',
      startLine: 3,
      endLine: 3,
      targetContent: '  return token;',
      contextBefore: ['function build() {', '  const token = source();'],
      contextAfter: ['}'],
    });
    const storeData = { version: 1, comments: [comment] };

    writeFile(
      tmpDir,
      'src/example.ts',
      [
        'function build() {',
        '  const token = source();',
        '  return token ?? "";',
        '}',
        '',
      ].join('\n')
    );

    const result = reconcile.reconcileStore(tmpDir, storeData);
    assert.equal(result.checkedComments, 1);
    assert.equal(result.updatedComments, 1);
    assert.equal(storeData.comments[0].workflowState, 'open');
    assert.equal(storeData.comments[0].anchorState, 'anchored');
    assert.equal(storeData.comments[0].anchor.startLine, 3);
    assert.equal(storeData.comments[0].anchor.targetContent, '  return token ?? "";');
  });

  it('marks comments stale when no reliable match is found', () => {
    writeFile(
      tmpDir,
      'src/example.ts',
      [
        'function build() {',
        '  const token = source();',
        '  return token;',
        '}',
        '',
      ].join('\n')
    );

    const comment = makeComment({
      id: 'c_stale',
      file: 'src/example.ts',
      startLine: 3,
      endLine: 3,
      targetContent: '  return token;',
      contextBefore: ['function build() {', '  const token = source();'],
      contextAfter: ['}'],
    });
    const storeData = { version: 1, comments: [comment] };

    writeFile(
      tmpDir,
      'src/example.ts',
      [
        'const other = 1;',
        'console.log(other);',
        '',
      ].join('\n')
    );

    const result = reconcile.reconcileStore(tmpDir, storeData);
    assert.equal(result.checkedComments, 1);
    assert.equal(storeData.comments[0].anchorState, 'stale');
  });

  it('marks comments orphaned when file is deleted', () => {
    writeFile(tmpDir, 'src/example.ts', 'const x = 1;\n');
    const comment = makeComment({
      id: 'c_orphan',
      file: 'src/example.ts',
      startLine: 1,
      endLine: 1,
      targetContent: 'const x = 1;',
      contextBefore: [],
      contextAfter: [],
    });
    const storeData = { version: 1, comments: [comment] };

    fs.unlinkSync(path.join(tmpDir, 'src', 'example.ts'));

    const result = reconcile.reconcileStore(tmpDir, storeData);
    assert.equal(result.checkedComments, 1);
    assert.equal(storeData.comments[0].anchorState, 'orphaned');
  });

  it('re-anchors stale comments without changing workflow state', () => {
    writeFile(tmpDir, 'src/example.ts', 'const x = 1;\n');
    const comment = makeComment({
      id: 'c_force',
      file: 'src/example.ts',
      startLine: 1,
      endLine: 1,
      targetContent: 'const x = 1;',
      contextBefore: [],
      contextAfter: [],
      workflowState: 'resolved',
      anchorState: 'stale',
    });
    const storeData = { version: 1, comments: [comment] };

    const defaultRun = reconcile.reconcileStore(tmpDir, storeData);
    assert.equal(defaultRun.checkedComments, 1);
    assert.equal(storeData.comments[0].anchorState, 'anchored');
    assert.equal(storeData.comments[0].workflowState, 'resolved');
  });
});

describe('cli lazy reconciliation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('reconciles and persists anchor updates during read commands', () => {
    writeFile(
      tmpDir,
      'src/main.ts',
      [
        'function main() {',
        '  const value = 1;',
        '  return value;',
        '}',
        '',
      ].join('\n')
    );

    seedStore(tmpDir, [
      makeComment({
        id: 'c_cli',
        file: 'src/main.ts',
        startLine: 3,
        endLine: 3,
        targetContent: '  return value;',
        contextBefore: ['function main() {', '  const value = 1;'],
        contextAfter: ['}'],
      }),
    ]);

    writeFile(
      tmpDir,
      'src/main.ts',
      [
        '// inserted',
        'function main() {',
        '  const value = 1;',
        '  return value;',
        '}',
        '',
      ].join('\n')
    );

    const out = run(['list', '--json'], tmpDir);
    const listed = JSON.parse(out);
    assert.equal(listed[0].anchor.startLine, 4);

    const persisted = readStoreFile(tmpDir);
    assert.equal(persisted.comments[0].anchor.startLine, 4);
  });

  it('marks deleted-file comments orphaned before context lookup', () => {
    writeFile(tmpDir, 'src/main.ts', 'const value = 1;\n');
    seedStore(tmpDir, [
      makeComment({
        id: 'c_ctx',
        file: 'src/main.ts',
        startLine: 1,
        endLine: 1,
        targetContent: 'const value = 1;',
        contextBefore: [],
        contextAfter: [],
      }),
    ]);

    fs.unlinkSync(path.join(tmpDir, 'src', 'main.ts'));

    const err = runFail(['context', 'c_ctx'], tmpDir);
    assert.ok(err.includes('orphaned'));

    const persisted = readStoreFile(tmpDir);
    assert.equal(persisted.comments[0].anchorState, 'orphaned');
  });
});
