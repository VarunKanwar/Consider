const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { archiveResolvedComments } = require('../../extension/out/archive.js');

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-archive-test-'));
  fs.mkdirSync(path.join(dir, '.feedback'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeStore(comments) {
  return { version: 1, comments };
}

function makeComment(id, status, file = 'src/main.ts', line = 1) {
  return {
    id,
    file,
    anchor: {
      startLine: line,
      endLine: line,
    },
    status,
    createdAt: '2025-02-15T10:00:00.000Z',
    author: 'human',
    body: `Comment ${id}`,
    thread: [],
  };
}

describe('archive resolved comments', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = makeTmpProject();
  });

  afterEach(() => {
    cleanup(projectRoot);
  });

  it('moves resolved comments into .feedback/archive.json and removes them from active store', () => {
    const store = makeStore([
      makeComment('c_open', 'open'),
      makeComment('c_resolved_1', 'resolved'),
      makeComment('c_resolved_2', 'resolved'),
    ]);

    const result = archiveResolvedComments(projectRoot, store);

    assert.equal(result.archivedCount, 2);
    assert.equal(result.remainingCount, 1);
    assert.equal(store.comments.length, 1);
    assert.equal(store.comments[0].id, 'c_open');

    const archivePath = path.join(projectRoot, '.feedback', 'archive.json');
    assert.ok(fs.existsSync(archivePath));
    const archive = JSON.parse(fs.readFileSync(archivePath, 'utf-8'));
    assert.equal(archive.version, 1);
    assert.equal(archive.comments.length, 2);
    assert.equal(archive.comments[0].comment.status, 'resolved');
    assert.ok(typeof archive.comments[0].archivedAt === 'string');
  });

  it('returns no-op result when there are no resolved comments', () => {
    const store = makeStore([
      makeComment('c_open', 'open'),
      makeComment('c_stale', 'stale'),
    ]);

    const result = archiveResolvedComments(projectRoot, store);

    assert.equal(result.archivedCount, 0);
    assert.equal(result.remainingCount, 2);
    assert.equal(store.comments.length, 2);
    assert.ok(!fs.existsSync(path.join(projectRoot, '.feedback', 'archive.json')));
  });

  it('appends to an existing archive across multiple runs', () => {
    const firstStore = makeStore([
      makeComment('c_resolved_1', 'resolved'),
      makeComment('c_open', 'open'),
    ]);
    archiveResolvedComments(projectRoot, firstStore);

    const secondStore = makeStore([
      makeComment('c_resolved_2', 'resolved'),
      makeComment('c_resolved_3', 'resolved'),
    ]);
    const secondResult = archiveResolvedComments(projectRoot, secondStore);

    assert.equal(secondResult.archivedCount, 2);
    const archive = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.feedback', 'archive.json'), 'utf-8')
    );
    assert.equal(archive.comments.length, 3);
    assert.equal(
      archive.comments.map((entry) => entry.comment.id).join(','),
      'c_resolved_1,c_resolved_2,c_resolved_3'
    );
  });
});

