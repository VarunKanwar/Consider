export {};
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = process.cwd();
const { runSetupAgentIntegration } = require(path.join(ROOT, 'extension', 'out', 'setup.js'));

function makeTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-setup-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(baseDir, relativePath, content) {
  const fullPath = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
}

function makeCliSource(baseDir) {
  const cliDir = path.join(baseDir, 'cli-src');
  fs.mkdirSync(cliDir, { recursive: true });
  writeFile(
    baseDir,
    'cli-src/feedback-cli',
    '#!/bin/sh\nexec node "$(dirname "$0")/feedback-cli.js" "$@"\n'
  );
  writeFile(
    baseDir,
    'cli-src/feedback-cli.js',
    '#!/usr/bin/env node\nconsole.log("feedback-cli stub");\n'
  );
  return cliDir;
}

function read(relativePath, projectRoot) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf-8');
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

describe('setup agent integration', () => {
  let projectRoot;
  let cliSourceDir;

  beforeEach(() => {
    projectRoot = makeTmpProject();
    cliSourceDir = makeCliSource(projectRoot);
  });

  afterEach(() => {
    cleanup(projectRoot);
  });

  it('creates feedback scaffolding, deploys CLI, and writes detected agent integrations', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.opencode'), { recursive: true });
    writeFile(projectRoot, 'AGENTS.md', '# Project Agents\n');

    const result = runSetupAgentIntegration(projectRoot, { cliSourceDir });

    assert.equal(result.feedbackDirCreated, true);
    assert.equal(result.binDirCreated, true);
    assert.equal(result.storeCreated, true);
    assert.equal(result.gitignoreUpdated, true);
    assert.equal(result.skillsWritten.length, 2);
    assert.equal(result.codexSectionUpdated, true);

    assert.ok(fs.existsSync(path.join(projectRoot, '.feedback', 'store.json')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.feedback', 'bin', 'feedback-cli')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.feedback', 'bin', 'feedback-cli.js')));
    assert.ok(
      fs
        .readFileSync(path.join(projectRoot, '.feedback', 'bin', 'feedback-cli'), 'utf-8')
        .includes('feedback-cli.js')
    );
    assert.ok(read('.gitignore', projectRoot).includes('.feedback/'));
    assert.ok(
      fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'feedback-loop', 'SKILL.md'))
    );
    assert.ok(
      fs.existsSync(path.join(projectRoot, '.opencode', 'skills', 'feedback-loop', 'SKILL.md'))
    );
    assert.ok(read('AGENTS.md', projectRoot).includes('feedback-loop:codex:start'));
  });

  it('falls back to installing all integrations when no agent config is detected', () => {
    const result = runSetupAgentIntegration(projectRoot, { cliSourceDir });

    assert.equal(result.usedFallbackToAllAgents, true);
    assert.ok(
      fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'feedback-loop', 'SKILL.md'))
    );
    assert.ok(
      fs.existsSync(path.join(projectRoot, '.opencode', 'skills', 'feedback-loop', 'SKILL.md'))
    );
    assert.ok(fs.existsSync(path.join(projectRoot, 'AGENTS.md')));
  });

  it('respects detected agents when at least one is present', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });

    const result = runSetupAgentIntegration(projectRoot, { cliSourceDir });

    assert.equal(result.usedFallbackToAllAgents, false);
    assert.ok(
      fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'feedback-loop', 'SKILL.md'))
    );
    assert.ok(!fs.existsSync(path.join(projectRoot, '.opencode')));
    assert.ok(!fs.existsSync(path.join(projectRoot, 'AGENTS.md')));
  });

  it('is idempotent for .gitignore and AGENTS codex section', () => {
    writeFile(projectRoot, 'AGENTS.md', '# Existing Agents\n');
    writeFile(projectRoot, '.gitignore', 'node_modules/\n');

    runSetupAgentIntegration(projectRoot, { cliSourceDir });
    runSetupAgentIntegration(projectRoot, { cliSourceDir });

    const gitignore = read('.gitignore', projectRoot);
    assert.equal(countOccurrences(gitignore, '.feedback/'), 1);

    const agents = read('AGENTS.md', projectRoot);
    assert.equal(countOccurrences(agents, 'feedback-loop:codex:start'), 1);
    assert.equal(countOccurrences(agents, 'feedback-loop:codex:end'), 1);
  });
});
