export {};
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  filterCommentsByVisibility,
  groupCommentsByFile,
} = require(path.join(process.cwd(), 'extension', 'out', 'tree-data.js'));

function makeComment(id, file, workflowState, anchorState, startLine, body) {
  return {
    id,
    file,
    anchor: {
      startLine,
      endLine: startLine,
    },
    workflowState,
    anchorState,
    createdAt: '2025-02-15T10:00:00.000Z',
    author: 'human',
    body,
    thread: [],
  };
}

describe('tree data helpers', () => {
  const comments = [
    makeComment('c3', 'src/b.ts', 'open', 'anchored', 20, 'B open later line'),
    makeComment('c1', 'src/a.ts', 'open', 'anchored', 10, 'A open'),
    makeComment('c2', 'src/a.ts', 'resolved', 'anchored', 5, 'A resolved'),
    makeComment('c4', 'src/b.ts', 'open', 'stale', 3, 'B stale'),
  ];

  it('filters by visibility toggles', () => {
    assert.equal(
      filterCommentsByVisibility(comments, { showResolved: true, showStale: true }).length,
      4
    );
    assert.equal(
      filterCommentsByVisibility(comments, { showResolved: false, showStale: true }).length,
      3
    );
    assert.equal(
      filterCommentsByVisibility(comments, { showResolved: true, showStale: false }).length,
      3
    );
    assert.equal(
      filterCommentsByVisibility(comments, { showResolved: false, showStale: false }).length,
      2
    );
  });

  it('groups comments by file and sorts files and line ranges', () => {
    const groups = groupCommentsByFile(comments, {
      showResolved: true,
      showStale: true,
    });
    assert.equal(groups.length, 2);
    assert.equal(groups[0].file, 'src/a.ts');
    assert.equal(groups[1].file, 'src/b.ts');
    assert.equal(groups[0].comments[0].id, 'c2');
    assert.equal(groups[0].comments[1].id, 'c1');
    assert.equal(groups[1].comments[0].id, 'c4');
    assert.equal(groups[1].comments[1].id, 'c3');
  });

  it('groups only matching comments for active filter', () => {
    const groups = groupCommentsByFile(comments, {
      showResolved: false,
      showStale: true,
    });
    assert.equal(groups.length, 2);
    assert.equal(groups[0].comments.length, 1);
    assert.equal(groups[1].comments.length, 2);
    assert.equal(groups[0].comments[0].workflowState, 'open');
    assert.equal(groups[1].comments[0].workflowState, 'open');
  });
});
