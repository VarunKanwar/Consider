const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('../../shared/store.js');

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
  fs.mkdirSync(path.join(dir, '.feedback'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('store', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('readStore returns empty store when file does not exist', () => {
    const data = store.readStore(tmpDir);
    assert.deepEqual(data, { version: 1, comments: [] });
  });

  it('writeStore and readStore roundtrip', () => {
    const data = store.emptyStore();
    data.comments.push({
      id: 'c_test1',
      file: 'src/main.ts',
      anchor: { startLine: 1, endLine: 1 },
      status: 'open',
      createdAt: '2025-01-01T00:00:00Z',
      author: 'human',
      body: 'Test comment',
      thread: [],
    });
    store.writeStore(tmpDir, data);
    const loaded = store.readStore(tmpDir);
    assert.equal(loaded.comments.length, 1);
    assert.equal(loaded.comments[0].id, 'c_test1');
    assert.equal(loaded.comments[0].body, 'Test comment');
  });

  it('writeStore creates .feedback directory if needed', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
    // No .feedback dir yet
    const data = store.emptyStore();
    store.writeStore(dir2, data);
    assert.ok(fs.existsSync(path.join(dir2, '.feedback', 'store.json')));
    cleanup(dir2);
  });

  it('atomic write does not leave tmp file', () => {
    store.writeStore(tmpDir, store.emptyStore());
    const files = fs.readdirSync(path.join(tmpDir, '.feedback'));
    assert.ok(!files.includes('store.json.tmp'));
  });

  it('generateCommentId has c_ prefix', () => {
    const id = store.generateCommentId();
    assert.ok(id.startsWith('c_'));
    assert.equal(id.length, 10); // c_ + 8 hex chars
  });

  it('generateReplyId has r_ prefix', () => {
    const id = store.generateReplyId();
    assert.ok(id.startsWith('r_'));
    assert.equal(id.length, 10);
  });

  it('findComment returns null for missing ID', () => {
    const data = store.emptyStore();
    assert.equal(store.findComment(data, 'c_nope'), null);
  });

  it('findComment finds existing comment', () => {
    const data = store.emptyStore();
    data.comments.push({ id: 'c_found', body: 'here' });
    assert.equal(store.findComment(data, 'c_found').body, 'here');
  });

  it('findProjectRoot walks up to find .feedback', () => {
    const subdir = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(subdir, { recursive: true });
    const found = store.findProjectRoot(subdir);
    assert.equal(found, tmpDir);
  });
});
