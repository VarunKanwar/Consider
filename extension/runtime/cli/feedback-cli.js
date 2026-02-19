#!/usr/bin/env node

/**
 * feedback-cli — CLI tool for AI agents to read/write inline code feedback.
 * Zero npm dependencies. Node builtins only.
 *
 * Commands:
 *   list [--workflow <state>] [--anchor <state>] [--status <legacy>] [--unseen] [--file <path>] [--json]
 *   get <comment-id> [--json]
 *   reply <comment-id> --message "..."
 *   resolve <comment-id>
 *   unresolve <comment-id>
 *   summary [--json]
 *   context <comment-id> [--lines N] [--json]
 */

const fs = require('fs');
const path = require('path');
const store = require('../shared/store.js');
const reconcile = require('../shared/reconcile.js');

const WORKFLOW_STATES = new Set(['open', 'resolved', 'all']);
const ANCHOR_STATES = new Set(['anchored', 'stale', 'orphaned', 'all']);

// --- Argument parsing ---

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const positional = [];
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      // Boolean flags
      if (key === 'json' || key === 'unseen') {
        flags[key] = true;
        continue;
      }
      // Flags with values
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { command, positional, flags };
}

// --- Helpers ---

function die(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function formatAnchor(comment) {
  const a = comment.anchor;
  if (a.startLine === a.endLine) {
    return `${comment.file}:${a.startLine}`;
  }
  return `${comment.file}:${a.startLine}-${a.endLine}`;
}

function truncate(str, maxLen = 80) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

function commentStateLabel(comment) {
  return `workflow=${comment.workflowState}, anchor=${comment.anchorState}`;
}

function parseLegacyStatusFilter(status) {
  switch (status) {
    case 'open':
      return { workflow: 'open', anchor: 'anchored' };
    case 'resolved':
      return { workflow: 'resolved', anchor: 'all' };
    case 'stale':
      return { workflow: 'all', anchor: 'stale' };
    case 'orphaned':
      return { workflow: 'all', anchor: 'orphaned' };
    case 'all':
      return { workflow: 'all', anchor: 'all' };
    default:
      return null;
  }
}

function parseListFilters(flags) {
  let workflow = flags.workflow || 'open';
  let anchor = flags.anchor || 'all';

  if (flags.status && !flags.workflow && !flags.anchor) {
    const mapped = parseLegacyStatusFilter(flags.status);
    if (!mapped) {
      die('Invalid --status value. Use open|resolved|stale|orphaned|all.');
    }
    workflow = mapped.workflow;
    anchor = mapped.anchor;
  }

  if (!WORKFLOW_STATES.has(workflow)) {
    die('Invalid --workflow value. Use open|resolved|all.');
  }
  if (!ANCHOR_STATES.has(anchor)) {
    die('Invalid --anchor value. Use anchored|stale|orphaned|all.');
  }

  return {
    workflow,
    anchor,
  };
}

function loadStoreForRead(projectRoot) {
  const data = store.readStore(projectRoot);
  const result = reconcile.reconcileStore(projectRoot, data);
  if (result.changed) {
    const updated = store.mutateStore(projectRoot, latest => {
      const latestResult = reconcile.reconcileStore(projectRoot, latest);
      if (!latestResult.changed) {
        return false;
      }
      return true;
    });
    return updated.store;
  }
  return data;
}

function latestHumanTimestamp(comment) {
  let latest = null;

  if (comment.author === 'human') {
    const createdMs = Date.parse(comment.createdAt || '');
    if (Number.isFinite(createdMs)) {
      latest = new Date(createdMs).toISOString();
    }
  }

  if (!Array.isArray(comment.thread)) {
    return latest;
  }

  for (const reply of comment.thread) {
    if (!reply || reply.author !== 'human') {
      continue;
    }
    const replyMs = Date.parse(reply.createdAt || '');
    if (!Number.isFinite(replyMs)) {
      continue;
    }
    const replyIso = new Date(replyMs).toISOString();
    if (!latest || replyIso > latest) {
      latest = replyIso;
    }
  }

  return latest;
}

// --- Commands ---

function cmdList(projectRoot, flags) {
  const data = loadStoreForRead(projectRoot);
  const fileFilter = flags.file || null;
  const { workflow, anchor } = parseListFilters(flags);

  let comments = data.comments;

  if (workflow !== 'all') {
    comments = comments.filter(c => c.workflowState === workflow);
  }

  if (anchor !== 'all') {
    comments = comments.filter(c => c.anchorState === anchor);
  }

  if (flags.unseen) {
    comments = comments.filter(c => store.hasUnseenHumanActivity(c));
  }

  if (fileFilter) {
    const normalized = fileFilter.replace(/\\/g, '/');
    comments = comments.filter(c => c.file.startsWith(normalized));
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(comments, null, 2) + '\n');
    return;
  }

  if (comments.length === 0) {
    process.stdout.write('No comments found for the selected filters.\n');
    return;
  }

  const filterParts = [`workflow=${workflow}`, `anchor=${anchor}`];
  if (flags.unseen) {
    filterParts.push('unseen=true');
  }
  process.stdout.write(`${comments.length} comment${comments.length === 1 ? '' : 's'} (${filterParts.join(', ')}):\n\n`);

  for (const c of comments) {
    const replyCount = c.thread ? c.thread.length : 0;
    const lastReplyAuthor = replyCount > 0 ? c.thread[replyCount - 1].author : null;
    const replyInfo = replyCount > 0
      ? `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}, last reply from: ${lastReplyAuthor}`
      : '0 replies';

    const unseen = store.hasUnseenHumanActivity(c) ? 'unseen' : 'seen';
    process.stdout.write(`[${c.id}] ${formatAnchor(c)} (${commentStateLabel(c)}, ${unseen})\n`);
    process.stdout.write(`  "${truncate(c.body)}"\n`);
    process.stdout.write(`  ${replyInfo}\n\n`);
  }
}

function cmdGet(projectRoot, commentId, flags) {
  if (!commentId) die('Usage: feedback-cli get <comment-id>');

  const data = loadStoreForRead(projectRoot);
  const comment = store.findComment(data, commentId);
  if (!comment) die(`Comment ${commentId} not found.`);

  if (flags.json) {
    process.stdout.write(JSON.stringify(comment, null, 2) + '\n');
    return;
  }

  process.stdout.write(`Comment ${comment.id} (${commentStateLabel(comment)})\n`);
  process.stdout.write(`File: ${formatAnchor(comment)}\n`);
  process.stdout.write(`Author: ${comment.author}\n`);
  process.stdout.write(`Created: ${comment.createdAt}\n`);
  process.stdout.write(`Agent last seen: ${comment.agentLastSeenAt || 'never'}\n`);
  process.stdout.write(`Latest human activity: ${latestHumanTimestamp(comment) || 'none'}\n`);
  process.stdout.write(`\n${comment.body}\n`);

  if (comment.thread && comment.thread.length > 0) {
    process.stdout.write(`\n--- Thread (${comment.thread.length} repl${comment.thread.length === 1 ? 'y' : 'ies'}) ---\n`);
    for (const reply of comment.thread) {
      process.stdout.write(`\n[${reply.id}] ${reply.author} (${reply.createdAt}):\n`);
      process.stdout.write(`${reply.body}\n`);
    }
  }
}

function cmdReply(projectRoot, commentId, flags) {
  if (!commentId) die('Usage: feedback-cli reply <comment-id> --message "..."');
  if (!flags.message) die('--message is required for reply command.');
  let replyId = '';

  store.mutateStore(projectRoot, data => {
    const comment = store.findComment(data, commentId);
    if (!comment) {
      throw new Error(`Comment ${commentId} not found.`);
    }
    if (comment.workflowState === 'resolved') {
      throw new Error(`Comment ${commentId} is resolved. Run unresolve before replying.`);
    }

    if (!comment.thread) {
      comment.thread = [];
    }

    const nowIso = new Date().toISOString();
    const reply = {
      id: store.generateReplyId(),
      author: 'agent',
      body: flags.message,
      createdAt: nowIso,
    };

    comment.thread.push(reply);
    store.markAgentSeen(comment, nowIso);
    replyId = reply.id;
    return true;
  });

  process.stdout.write(`Reply ${replyId} added to comment ${commentId}.\n`);
}

function cmdResolve(projectRoot, commentId) {
  if (!commentId) die('Usage: feedback-cli resolve <comment-id>');
  let alreadyResolved = false;

  store.mutateStore(projectRoot, data => {
    const comment = store.findComment(data, commentId);
    if (!comment) {
      throw new Error(`Comment ${commentId} not found.`);
    }

    if (comment.workflowState === 'resolved') {
      alreadyResolved = true;
      return false;
    }

    comment.workflowState = 'resolved';
    store.markAgentSeen(comment, new Date().toISOString());
    return true;
  });

  if (alreadyResolved) {
    process.stdout.write(`Comment ${commentId} is already resolved.\n`);
    return;
  }

  process.stdout.write(`Comment ${commentId} resolved.\n`);
}

function cmdUnresolve(projectRoot, commentId) {
  if (!commentId) die('Usage: feedback-cli unresolve <comment-id>');
  let alreadyOpen = false;

  store.mutateStore(projectRoot, data => {
    const comment = store.findComment(data, commentId);
    if (!comment) {
      throw new Error(`Comment ${commentId} not found.`);
    }

    if (comment.workflowState === 'open') {
      alreadyOpen = true;
      return false;
    }

    comment.workflowState = 'open';
    store.markAgentSeen(comment, new Date().toISOString());
    return true;
  });

  if (alreadyOpen) {
    process.stdout.write(`Comment ${commentId} is already open.\n`);
    return;
  }

  process.stdout.write(`Comment ${commentId} reopened.\n`);
}

function cmdSummary(projectRoot, flags) {
  const data = loadStoreForRead(projectRoot);
  const comments = data.comments;

  const byWorkflow = {};
  const byAnchor = {};
  const files = new Set();
  let unseenOpenCount = 0;

  for (const c of comments) {
    byWorkflow[c.workflowState] = (byWorkflow[c.workflowState] || 0) + 1;
    byAnchor[c.anchorState] = (byAnchor[c.anchorState] || 0) + 1;

    if (c.workflowState === 'open') {
      files.add(c.file);
      if (store.hasUnseenHumanActivity(c)) {
        unseenOpenCount += 1;
      }
    }
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      total: comments.length,
      byWorkflow,
      byAnchor,
      openFilesCount: files.size,
      openFiles: [...files],
      unseenOpenCount,
    }, null, 2) + '\n');
    return;
  }

  if (comments.length === 0) {
    process.stdout.write('No feedback comments.\n');
    return;
  }

  const openCount = byWorkflow.open || 0;
  process.stdout.write(`${openCount} open comment${openCount === 1 ? '' : 's'} across ${files.size} file${files.size === 1 ? '' : 's'}.\n`);
  process.stdout.write(`Unseen open comments: ${unseenOpenCount}.\n`);

  const workflowParts = Object.entries(byWorkflow).map(([state, count]) => `${count} ${state}`);
  if (workflowParts.length > 0) {
    process.stdout.write(`Workflow: ${workflowParts.join(', ')}.\n`);
  }

  const anchorParts = Object.entries(byAnchor).map(([state, count]) => `${count} ${state}`);
  if (anchorParts.length > 0) {
    process.stdout.write(`Anchors: ${anchorParts.join(', ')}.\n`);
  }

  if (files.size > 0) {
    process.stdout.write(`\nFiles with open comments:\n`);
    for (const f of files) {
      process.stdout.write(`  ${f}\n`);
    }
  }
}

function cmdContext(projectRoot, commentId, flags) {
  if (!commentId) die('Usage: feedback-cli context <comment-id>');

  const data = loadStoreForRead(projectRoot);
  const comment = store.findComment(data, commentId);
  if (!comment) die(`Comment ${commentId} not found.`);

  if (comment.anchorState === 'orphaned') {
    die(`Comment ${commentId} is orphaned — the file ${comment.file} no longer exists.`);
  }

  const filePath = path.join(projectRoot, comment.file);
  if (!fs.existsSync(filePath)) {
    die(`File not found: ${comment.file}`);
  }

  const contextLines = parseInt(flags.lines, 10) || 10;
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const lines = fileContent.split('\n');

  const startLine = comment.anchor.startLine;
  const endLine = comment.anchor.endLine;

  // Context window (1-based line numbers, convert to 0-based index)
  const contextStart = Math.max(0, startLine - 1 - contextLines);
  const contextEnd = Math.min(lines.length, endLine + contextLines);

  const snippet = [];
  for (let i = contextStart; i < contextEnd; i++) {
    const lineNum = i + 1;
    const isTarget = lineNum >= startLine && lineNum <= endLine;
    const marker = isTarget ? '>>>' : '   ';
    snippet.push({ lineNum, marker, text: lines[i] });
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      comment,
      context: {
        file: comment.file,
        startLine: contextStart + 1,
        endLine: contextEnd,
        lines: snippet.map(s => ({ lineNum: s.lineNum, isTarget: s.marker === '>>>', text: s.text })),
      },
    }, null, 2) + '\n');
    return;
  }

  process.stdout.write(`Comment ${comment.id} (${commentStateLabel(comment)})\n`);
  process.stdout.write(`File: ${formatAnchor(comment)}\n`);
  process.stdout.write(`Author: ${comment.author}\n`);
  process.stdout.write(`\n${comment.body}\n`);

  if (comment.thread && comment.thread.length > 0) {
    process.stdout.write(`\n--- Thread (${comment.thread.length} repl${comment.thread.length === 1 ? 'y' : 'ies'}) ---\n`);
    for (const reply of comment.thread) {
      process.stdout.write(`[${reply.id}] ${reply.author}: ${reply.body}\n`);
    }
  }

  process.stdout.write(`\n--- Code Context (${comment.file}) ---\n`);
  for (const s of snippet) {
    process.stdout.write(`${s.marker} ${String(s.lineNum).padStart(4)} | ${s.text}\n`);
  }
}

function printHelp() {
  process.stdout.write(`feedback-cli — Inline code feedback for AI agents

Usage: feedback-cli <command> [options]

Commands:
  list [--workflow open|resolved|all] [--anchor anchored|stale|orphaned|all] [--status open|resolved|stale|orphaned|all] [--unseen] [--file <path>] [--json]
      List comments. Default filters: workflow=open, anchor=all.
      --status is a legacy alias for backward compatibility.

  get <comment-id> [--json]
      Get a comment with its full thread.

  reply <comment-id> --message "..."
      Reply to a comment thread (as agent).

  resolve <comment-id>
      Mark a comment as resolved.

  unresolve <comment-id>
      Reopen a resolved comment.

  summary [--json]
      Summary of open comments across the project.

  context <comment-id> [--lines N] [--json]
      Show a comment with surrounding code context. Default: 10 lines.
`);
}

// --- Main ---

function main() {
  const { command, positional, flags } = parseArgs(process.argv);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  try {
    const projectRoot = store.findProjectRoot(process.cwd());

    switch (command) {
      case 'list':
        cmdList(projectRoot, flags);
        break;
      case 'get':
        cmdGet(projectRoot, positional[0], flags);
        break;
      case 'reply':
        cmdReply(projectRoot, positional[0], flags);
        break;
      case 'resolve':
        cmdResolve(projectRoot, positional[0]);
        break;
      case 'unresolve':
        cmdUnresolve(projectRoot, positional[0]);
        break;
      case 'summary':
        cmdSummary(projectRoot, flags);
        break;
      case 'context':
        cmdContext(projectRoot, positional[0], flags);
        break;
      default:
        die(`Unknown command: ${command}. Run feedback-cli --help for usage.`);
    }
  } catch (err) {
    if (err && err.code === 'ESTORELOCKTIMEOUT') {
      die('Feedback store is busy. Retry in a moment.');
    }
    if (err && err.code === 'ESTORECONFLICT') {
      die('Feedback store changed during update. Retry the command.');
    }
    if (err && typeof err.message === 'string') {
      die(err.message);
    }
    throw err;
  }
}

main();
