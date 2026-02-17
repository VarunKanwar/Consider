export {};
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  filterCommentsByStatus,
  groupCommentsByFile,
} = require(path.join(process.cwd(), 'extension', 'out', 'tree-data.js'));

function makeComment(id, file, status, startLine, body) {
  return {
    id,
    file,
    anchor: {
      startLine,
      endLine: startLine,
    },
    status,
    createdAt: '2025-02-15T10:00:00.000Z',
    author: 'human',
    body,
    thread: [],
  };
}

describe('tree data helpers', () => {
  const comments = [
    makeComment('c3', 'src/b.ts', 'open', 20, 'B open later line'),
    makeComment('c1', 'src/a.ts', 'open', 10, 'A open'),
    makeComment('c2', 'src/a.ts', 'resolved', 5, 'A resolved'),
    makeComment('c4', 'src/b.ts', 'stale', 3, 'B stale'),
  ];

  it('filters by status with support for all', () => {
    assert.equal(filterCommentsByStatus(comments, 'all').length, 4);
    assert.equal(filterCommentsByStatus(comments, 'open').length, 2);
    assert.equal(filterCommentsByStatus(comments, 'resolved').length, 1);
    assert.equal(filterCommentsByStatus(comments, 'stale').length, 1);
  });

  it('groups comments by file and sorts files and line ranges', () => {
    const groups = groupCommentsByFile(comments, 'all');
    assert.equal(groups.length, 2);
    assert.equal(groups[0].file, 'src/a.ts');
    assert.equal(groups[1].file, 'src/b.ts');
    assert.equal(groups[0].comments[0].id, 'c2');
    assert.equal(groups[0].comments[1].id, 'c1');
    assert.equal(groups[1].comments[0].id, 'c4');
    assert.equal(groups[1].comments[1].id, 'c3');
  });

  it('groups only matching comments for active filter', () => {
    const groups = groupCommentsByFile(comments, 'open');
    assert.equal(groups.length, 2);
    assert.equal(groups[0].comments.length, 1);
    assert.equal(groups[1].comments.length, 1);
    assert.equal(groups[0].comments[0].status, 'open');
    assert.equal(groups[1].comments[0].status, 'open');
  });
});
