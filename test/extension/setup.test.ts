export {};
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = process.cwd();
const {
  detectAgentIntegrations,
  getDetectedIntegrationTargets,
  runSetupAgentIntegration,
} = require(path.join(ROOT, 'extension', 'out', 'setup.js'));

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

  it('creates feedback scaffolding and deploys CLI without writing integrations by default', () => {
    const result = runSetupAgentIntegration(projectRoot, { cliSourceDir });

    assert.equal(result.feedbackDirCreated, true);
    assert.equal(result.binDirCreated, true);
    assert.equal(result.storeCreated, true);
    assert.equal(result.gitignoreUpdated, true);
    assert.equal(result.gitignoreSkipped, false);
    assert.equal(result.skillsWritten.length, 0);
    assert.equal(result.codexSectionUpdated, false);
    assert.equal(result.integrationTargetsRequested.length, 0);

    assert.ok(fs.existsSync(path.join(projectRoot, '.feedback', 'store.json')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.feedback', 'bin', 'feedback-cli')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.feedback', 'bin', 'feedback-cli.js')));
    assert.ok(
      fs
        .readFileSync(path.join(projectRoot, '.feedback', 'bin', 'feedback-cli'), 'utf-8')
        .includes('feedback-cli.js')
    );
    assert.ok(read('.gitignore', projectRoot).includes('.feedback/'));
    assert.ok(!fs.existsSync(path.join(projectRoot, '.claude')));
    assert.ok(!fs.existsSync(path.join(projectRoot, '.opencode')));
    assert.ok(!fs.existsSync(path.join(projectRoot, 'AGENTS.md')));
  });

  it('installs only explicitly requested integration targets', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });

    const result = runSetupAgentIntegration(projectRoot, {
      cliSourceDir,
      integrationTargets: ['claude', 'codex'],
    });

    assert.equal(result.integrationTargetsRequested.length, 2);
    assert.ok(result.integrationTargetsRequested.includes('claude'));
    assert.ok(result.integrationTargetsRequested.includes('codex'));
    assert.ok(
      fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'feedback-loop', 'SKILL.md'))
    );
    assert.ok(!fs.existsSync(path.join(projectRoot, '.opencode')));
    assert.ok(fs.existsSync(path.join(projectRoot, 'AGENTS.md')));
    assert.ok(read('AGENTS.md', projectRoot).includes('feedback-loop:codex:start'));
  });

  it('supports skipping .gitignore updates', () => {
    writeFile(projectRoot, '.gitignore', 'node_modules/\n');

    const result = runSetupAgentIntegration(projectRoot, {
      cliSourceDir,
      addGitignoreEntry: false,
    });

    assert.equal(result.gitignoreUpdated, false);
    assert.equal(result.gitignoreSkipped, true);
    assert.equal(read('.gitignore', projectRoot), 'node_modules/\n');
  });

  it('is idempotent for .gitignore and AGENTS codex section with explicit targets', () => {
    writeFile(projectRoot, 'AGENTS.md', '# Existing Agents\n');
    writeFile(projectRoot, '.gitignore', 'node_modules/\n');

    const first = runSetupAgentIntegration(projectRoot, {
      cliSourceDir,
      integrationTargets: ['codex', 'codex'],
    });
    runSetupAgentIntegration(projectRoot, {
      cliSourceDir,
      integrationTargets: ['codex'],
    });

    assert.equal(first.integrationTargetsRequested.length, 1);
    assert.equal(first.integrationTargetsRequested[0], 'codex');

    const gitignore = read('.gitignore', projectRoot);
    assert.equal(countOccurrences(gitignore, '.feedback/'), 1);

    const agents = read('AGENTS.md', projectRoot);
    assert.equal(countOccurrences(agents, 'feedback-loop:codex:start'), 1);
    assert.equal(countOccurrences(agents, 'feedback-loop:codex:end'), 1);
  });

  it('detects existing integration footprints for guided setup defaults', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    writeFile(projectRoot, 'AGENTS.md', '# Existing\n');

    const detection = detectAgentIntegrations(projectRoot);
    const targets = getDetectedIntegrationTargets(detection);

    assert.equal(detection.claudeDirExists, true);
    assert.equal(detection.openCodeDirExists, false);
    assert.equal(detection.agentsMdExists, true);
    assert.equal(detection.noneDetected, false);
    assert.deepEqual(targets, ['claude', 'codex']);
  });
});
