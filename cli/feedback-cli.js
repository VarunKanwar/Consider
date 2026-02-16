#!/usr/bin/env node

/**
 * feedback-cli — CLI tool for AI agents to read/write inline code feedback.
 * Zero npm dependencies. Node builtins only.
 *
 * Commands:
 *   list [--status <status>] [--file <path>] [--json]
 *   get <comment-id> [--json]
 *   reply <comment-id> --message "..."
 *   resolve <comment-id>
 *   summary [--json]
 *   context <comment-id> [--lines N] [--json]
 */

const fs = require('fs');
const path = require('path');
const store = require('../shared/store.js');
const reconcile = require('../shared/reconcile.js');

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
      if (key === 'json') {
        flags.json = true;
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

function loadStoreForRead(projectRoot) {
  const data = store.readStore(projectRoot);
  const result = reconcile.reconcileStore(projectRoot, data);
  if (result.changed) {
    store.writeStore(projectRoot, data);
  }
  return data;
}

// --- Commands ---

function cmdList(projectRoot, flags) {
  const data = loadStoreForRead(projectRoot);
  const statusFilter = flags.status || 'open';
  const fileFilter = flags.file || null;

  let comments = data.comments;

  // Filter by status
  if (statusFilter !== 'all') {
    comments = comments.filter(c => c.status === statusFilter);
  }

  // Filter by file (prefix match to support directory filtering)
  if (fileFilter) {
    const normalized = fileFilter.replace(/\\/g, '/');
    comments = comments.filter(c => c.file.startsWith(normalized));
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(comments, null, 2) + '\n');
    return;
  }

  if (comments.length === 0) {
    process.stdout.write(`No ${statusFilter === 'all' ? '' : statusFilter + ' '}comments found.\n`);
    return;
  }

  process.stdout.write(`${comments.length} ${statusFilter === 'all' ? '' : statusFilter + ' '}comment${comments.length === 1 ? '' : 's'}:\n\n`);

  for (const c of comments) {
    const replyCount = c.thread ? c.thread.length : 0;
    const lastReplyAuthor = replyCount > 0 ? c.thread[replyCount - 1].author : null;
    const replyInfo = replyCount > 0
      ? `${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}, last reply from: ${lastReplyAuthor}`
      : '0 replies';

    process.stdout.write(`[${c.id}] ${formatAnchor(c)} (${c.status})\n`);
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

  process.stdout.write(`Comment ${comment.id} (${comment.status})\n`);
  process.stdout.write(`File: ${formatAnchor(comment)}\n`);
  process.stdout.write(`Author: ${comment.author}\n`);
  process.stdout.write(`Created: ${comment.createdAt}\n`);
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

  const data = store.readStore(projectRoot);
  const comment = store.findComment(data, commentId);
  if (!comment) die(`Comment ${commentId} not found.`);

  if (!comment.thread) {
    comment.thread = [];
  }

  const reply = {
    id: store.generateReplyId(),
    author: 'agent',
    body: flags.message,
    createdAt: new Date().toISOString(),
  };

  comment.thread.push(reply);
  store.writeStore(projectRoot, data);

  process.stdout.write(`Reply ${reply.id} added to comment ${commentId}.\n`);
}

function cmdResolve(projectRoot, commentId) {
  if (!commentId) die('Usage: feedback-cli resolve <comment-id>');

  const data = store.readStore(projectRoot);
  const comment = store.findComment(data, commentId);
  if (!comment) die(`Comment ${commentId} not found.`);

  if (comment.status === 'resolved') {
    process.stdout.write(`Comment ${commentId} is already resolved.\n`);
    return;
  }

  comment.status = 'resolved';
  store.writeStore(projectRoot, data);

  process.stdout.write(`Comment ${commentId} resolved.\n`);
}

function cmdSummary(projectRoot, flags) {
  const data = loadStoreForRead(projectRoot);
  const comments = data.comments;

  const byStatus = {};
  const files = new Set();
  for (const c of comments) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    if (c.status === 'open') {
      files.add(c.file);
    }
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      total: comments.length,
      byStatus,
      openFilesCount: files.size,
      openFiles: [...files],
    }, null, 2) + '\n');
    return;
  }

  if (comments.length === 0) {
    process.stdout.write('No feedback comments.\n');
    return;
  }

  const openCount = byStatus.open || 0;
  process.stdout.write(`${openCount} open comment${openCount === 1 ? '' : 's'} across ${files.size} file${files.size === 1 ? '' : 's'}.\n`);

  const statuses = Object.entries(byStatus);
  if (statuses.length > 0) {
    const parts = statuses.map(([s, n]) => `${n} ${s}`);
    process.stdout.write(`Breakdown: ${parts.join(', ')}.\n`);
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

  if (comment.status === 'orphaned') {
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

  process.stdout.write(`Comment ${comment.id} (${comment.status})\n`);
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
  list [--status open|resolved|stale|orphaned|all] [--file <path>] [--json]
      List comments. Default: all open comments.

  get <comment-id> [--json]
      Get a comment with its full thread.

  reply <comment-id> --message "..."
      Reply to a comment thread (as agent).

  resolve <comment-id>
      Mark a comment as resolved.

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
    case 'summary':
      cmdSummary(projectRoot, flags);
      break;
    case 'context':
      cmdContext(projectRoot, positional[0], flags);
      break;
    default:
      die(`Unknown command: ${command}. Run feedback-cli --help for usage.`);
  }
}

main();
