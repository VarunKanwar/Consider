export {};
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const CLI_PATH = path.join(ROOT, 'cli', 'feedback-cli.js');

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-cli-test-'));
  fs.mkdirSync(path.join(dir, '.feedback'), { recursive: true });
  // Create a sample source file for context tests
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), [
    'import { config } from "./config";',
    '',
    'function main() {',
    '  const x = 1;',
    '  const y = 2;',
    '  const z = x + y;',
    '  console.log(z);',
    '  return z;',
    '}',
    '',
    'main();',
    '',
  ].join('\n'));
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function seedStore(dir, comments) {
  const storePath = path.join(dir, '.feedback', 'store.json');
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, comments }, null, 2));
}

function readStoreFile(dir) {
  const raw = fs.readFileSync(path.join(dir, '.feedback', 'store.json'), 'utf-8');
  return JSON.parse(raw);
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
  } catch (e) {
    return e.stderr;
  }
}

const SAMPLE_COMMENTS = [
  {
    id: 'c_aaa11111',
    file: 'src/main.ts',
    anchor: { startLine: 4, endLine: 4, targetContent: '  const x = 1;' },
    status: 'open',
    createdAt: '2025-02-15T10:00:00Z',
    author: 'human',
    body: 'This variable name is too short.',
    thread: [
      {
        id: 'r_bbb22222',
        author: 'agent',
        body: 'I will rename it to something descriptive.',
        createdAt: '2025-02-15T10:01:00Z',
      },
    ],
  },
  {
    id: 'c_ccc33333',
    file: 'src/main.ts',
    anchor: { startLine: 6, endLine: 6, targetContent: '  const z = x + y;' },
    status: 'open',
    createdAt: '2025-02-15T10:02:00Z',
    author: 'human',
    body: 'Missing null check on inputs.',
    thread: [],
  },
  {
    id: 'c_ddd44444',
    file: 'src/config.ts',
    anchor: { startLine: 1, endLine: 1, targetContent: 'export const config = {};' },
    status: 'resolved',
    createdAt: '2025-02-15T09:00:00Z',
    author: 'human',
    body: 'Config should be loaded from env.',
    thread: [],
  },
  {
    id: 'c_eee55555',
    file: 'src/deleted.ts',
    anchor: { startLine: 1, endLine: 1 },
    status: 'orphaned',
    createdAt: '2025-02-15T08:00:00Z',
    author: 'human',
    body: 'This file needs refactoring.',
    thread: [],
  },
];

describe('cli', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpProject();
    seedStore(tmpDir, SAMPLE_COMMENTS);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // --- help ---
  describe('help', () => {
    it('shows help with --help', () => {
      const out = run(['--help'], tmpDir);
      assert.ok(out.includes('feedback-cli'));
      assert.ok(out.includes('list'));
      assert.ok(out.includes('reply'));
    });
  });

  // --- list ---
  describe('list', () => {
    it('lists open comments by default', () => {
      const out = run(['list'], tmpDir);
      assert.ok(out.includes('c_aaa11111'));
      assert.ok(out.includes('c_ccc33333'));
      assert.ok(!out.includes('c_ddd44444')); // resolved
      assert.ok(!out.includes('c_eee55555')); // orphaned
    });

    it('lists all comments with --status all', () => {
      const out = run(['list', '--status', 'all'], tmpDir);
      assert.ok(out.includes('c_aaa11111'));
      assert.ok(out.includes('c_ddd44444'));
      assert.ok(out.includes('c_eee55555'));
    });

    it('filters by status', () => {
      const out = run(['list', '--status', 'resolved'], tmpDir);
      assert.ok(out.includes('c_ddd44444'));
      assert.ok(!out.includes('c_aaa11111'));
    });

    it('filters by file path', () => {
      const out = run(['list', '--status', 'all', '--file', 'src/config.ts'], tmpDir);
      assert.ok(out.includes('c_ddd44444'));
      assert.ok(!out.includes('c_aaa11111'));
    });

    it('filters by file directory prefix', () => {
      const out = run(['list', '--status', 'all', '--file', 'src/'], tmpDir);
      assert.ok(out.includes('c_aaa11111'));
      assert.ok(out.includes('c_ddd44444'));
    });

    it('outputs JSON with --json', () => {
      const out = run(['list', '--json'], tmpDir);
      const data = JSON.parse(out);
      assert.ok(Array.isArray(data));
      assert.equal(data.length, 2); // 2 open
      assert.equal(data[0].id, 'c_aaa11111');
    });

    it('reports no comments when empty', () => {
      seedStore(tmpDir, []);
      const out = run(['list'], tmpDir);
      assert.ok(out.includes('No'));
    });

    it('shows reply count and last author', () => {
      const out = run(['list'], tmpDir);
      assert.ok(out.includes('1 reply, last reply from: agent'));
      assert.ok(out.includes('0 replies'));
    });
  });

  // --- get ---
  describe('get', () => {
    it('shows comment details', () => {
      const out = run(['get', 'c_aaa11111'], tmpDir);
      assert.ok(out.includes('c_aaa11111'));
      assert.ok(out.includes('This variable name is too short.'));
      assert.ok(out.includes('I will rename it to something descriptive.'));
      assert.ok(out.includes('human'));
    });

    it('outputs JSON with --json', () => {
      const out = run(['get', 'c_aaa11111', '--json'], tmpDir);
      const data = JSON.parse(out);
      assert.equal(data.id, 'c_aaa11111');
      assert.equal(data.thread.length, 1);
    });

    it('fails on nonexistent comment', () => {
      const err = runFail(['get', 'c_nope'], tmpDir);
      assert.ok(err.includes('not found'));
    });

    it('fails when no comment-id provided', () => {
      const err = runFail(['get'], tmpDir);
      assert.ok(err.includes('Usage'));
    });
  });

  // --- reply ---
  describe('reply', () => {
    it('adds a reply to a comment', () => {
      run(['reply', 'c_ccc33333', '--message', 'Will fix.'], tmpDir);
      const data = readStoreFile(tmpDir);
      const comment = data.comments.find(c => c.id === 'c_ccc33333');
      assert.equal(comment.thread.length, 1);
      assert.equal(comment.thread[0].author, 'agent');
      assert.equal(comment.thread[0].body, 'Will fix.');
      assert.ok(comment.thread[0].id.startsWith('r_'));
    });

    it('appends to existing thread', () => {
      run(['reply', 'c_aaa11111', '--message', 'Done.'], tmpDir);
      const data = readStoreFile(tmpDir);
      const comment = data.comments.find(c => c.id === 'c_aaa11111');
      assert.equal(comment.thread.length, 2);
      assert.equal(comment.thread[1].body, 'Done.');
    });

    it('fails without --message', () => {
      const err = runFail(['reply', 'c_aaa11111'], tmpDir);
      assert.ok(err.includes('--message'));
    });

    it('fails on nonexistent comment', () => {
      const err = runFail(['reply', 'c_nope', '--message', 'x'], tmpDir);
      assert.ok(err.includes('not found'));
    });
  });

  // --- resolve ---
  describe('resolve', () => {
    it('resolves an open comment', () => {
      run(['resolve', 'c_aaa11111'], tmpDir);
      const data = readStoreFile(tmpDir);
      const comment = data.comments.find(c => c.id === 'c_aaa11111');
      assert.equal(comment.status, 'resolved');
    });

    it('reports already resolved', () => {
      const out = run(['resolve', 'c_ddd44444'], tmpDir);
      assert.ok(out.includes('already resolved'));
    });

    it('fails on nonexistent comment', () => {
      const err = runFail(['resolve', 'c_nope'], tmpDir);
      assert.ok(err.includes('not found'));
    });
  });

  // --- summary ---
  describe('summary', () => {
    it('shows open count and file count', () => {
      const out = run(['summary'], tmpDir);
      assert.ok(out.includes('2 open comments'));
      assert.ok(out.includes('1 file'));
    });

    it('outputs JSON', () => {
      const out = run(['summary', '--json'], tmpDir);
      const data = JSON.parse(out);
      assert.equal(data.total, 4);
      assert.equal(data.byStatus.open, 2);
      assert.equal(data.byStatus.resolved, 1);
      assert.equal(data.byStatus.orphaned, 1);
      assert.equal(data.openFilesCount, 1);
    });

    it('handles empty store', () => {
      seedStore(tmpDir, []);
      const out = run(['summary'], tmpDir);
      assert.ok(out.includes('No feedback'));
    });
  });

  // --- context ---
  describe('context', () => {
    it('shows code context around a comment', () => {
      const out = run(['context', 'c_aaa11111'], tmpDir);
      assert.ok(out.includes('const x = 1'));
      assert.ok(out.includes('>>>'));
      assert.ok(out.includes('This variable name is too short.'));
    });

    it('respects --lines flag', () => {
      const out = run(['context', 'c_aaa11111', '--lines', '2'], tmpDir);
      // Should show fewer context lines
      assert.ok(out.includes('const x = 1'));
    });

    it('outputs JSON', () => {
      const out = run(['context', 'c_aaa11111', '--json'], tmpDir);
      const data = JSON.parse(out);
      assert.equal(data.comment.id, 'c_aaa11111');
      assert.ok(data.context.lines.length > 0);
      const targetLine = data.context.lines.find(l => l.isTarget);
      assert.ok(targetLine);
    });

    it('fails on orphaned comment', () => {
      const err = runFail(['context', 'c_eee55555'], tmpDir);
      assert.ok(err.includes('orphaned'));
    });

    it('fails when file does not exist', () => {
      // c_ddd44444 points to src/config.ts which doesn't exist in tmp project
      const err = runFail(['context', 'c_ddd44444'], tmpDir);
      assert.ok(err.includes('File not found') || err.includes('not found'));
    });
  });

  // --- unknown command ---
  describe('unknown command', () => {
    it('shows error for unknown command', () => {
      const err = runFail(['foobar'], tmpDir);
      assert.ok(err.includes('Unknown command'));
    });
  });

  // --- empty store ---
  describe('empty store', () => {
    it('list works with no store file', () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-empty-'));
      fs.mkdirSync(path.join(dir2, '.feedback'));
      const out = run(['list'], dir2);
      assert.ok(out.includes('No'));
      cleanup(dir2);
    });
  });
});
