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
  runUninstallAgentIntegration,
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
  const sharedDir = path.join(baseDir, 'shared');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  writeFile(
    baseDir,
    'cli-src/consider-cli',
    '#!/bin/sh\nexec node "$(dirname "$0")/consider-cli.js" "$@"\n'
  );
  writeFile(
    baseDir,
    'cli-src/consider-cli.js',
    '#!/usr/bin/env node\nconsole.log("consider-cli stub");\n'
  );
  writeFile(
    baseDir,
    'shared/store.js',
    'module.exports = {};\n'
  );
  writeFile(
    baseDir,
    'shared/reconcile.js',
    'module.exports = {};\n'
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

function assertHasSkillFrontmatter(skillContent) {
  assert.ok(skillContent.startsWith('---\n'));
  assert.ok(skillContent.includes('\nname: consider\n'));
  assert.ok(skillContent.includes('\ndescription: '));
  assert.ok(skillContent.includes('\n---\n\n# Consider\n'));
}

function assertHasCodexOpenAiMetadata(metadataContent) {
  assert.ok(metadataContent.includes('interface:\n'));
  assert.ok(metadataContent.includes('display_name: "Consider"\n'));
  assert.ok(
    metadataContent.includes(
      'short_description: "Review and reply to inline Consider threads"\n'
    )
  );
  assert.ok(metadataContent.includes('default_prompt: "Use $consider '));
}

function readJson(relativePath, projectRoot) {
  return JSON.parse(read(relativePath, projectRoot));
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

    assert.equal(result.considerDirCreated, true);
    assert.equal(result.binDirCreated, true);
    assert.equal(result.storeCreated, true);
    assert.equal(result.gitignoreUpdated, true);
    assert.equal(result.gitignoreSkipped, false);
    assert.equal(result.skillsWritten.length, 0);
    assert.equal(result.integrationTargetsRequested.length, 0);
    assert.equal(result.integrationInstallsRequested.length, 0);

    assert.ok(fs.existsSync(path.join(projectRoot, '.consider', 'store.json')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.consider', 'bin', 'consider-cli')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.consider', 'bin', 'consider-cli.js')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.consider', 'bin', 'consider-cli.cjs')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.consider', 'bin', 'package.json')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.consider', 'shared', 'store.js')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.consider', 'shared', 'reconcile.js')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.consider', 'shared', 'package.json')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.consider', 'config.json')));
    assert.ok(
      fs
        .readFileSync(path.join(projectRoot, '.consider', 'bin', 'consider-cli'), 'utf-8')
        .includes('consider-cli.cjs')
    );
    assert.ok(read('.gitignore', projectRoot).includes('.consider/'));
    assert.ok(!fs.existsSync(path.join(projectRoot, '.claude')));
    assert.ok(!fs.existsSync(path.join(projectRoot, '.opencode')));
    assert.ok(!fs.existsSync(path.join(projectRoot, '.codex')));
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
    assert.deepEqual(result.integrationInstallsRequested, [
      { target: 'claude', scope: 'project' },
      { target: 'codex', scope: 'project' },
    ]);
    assert.ok(
      fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'consider', 'SKILL.md'))
    );
    assert.ok(!fs.existsSync(path.join(projectRoot, '.opencode')));
    assert.ok(
      fs.existsSync(path.join(projectRoot, '.codex', 'skills', 'consider', 'SKILL.md'))
    );
  });

  it('supports skipping .gitignore updates', () => {
    writeFile(projectRoot, '.gitignore', 'node_modules/\n');

    const result = runSetupAgentIntegration(projectRoot, {
      cliSourceDir,
      addGitignoreEntry: false,
    });

    assert.equal(result.gitignoreUpdated, false);
    assert.equal(result.gitignoreSkipped, true);
    assert.equal(result.integrationInstallsRequested.length, 0);
    assert.equal(read('.gitignore', projectRoot), 'node_modules/\n');
  });

  it('writes selected skills to home when integration scope is home', () => {
    const controlledHome = path.join(projectRoot, 'fake-home');
    fs.mkdirSync(controlledHome, { recursive: true });

    const result = runSetupAgentIntegration(projectRoot, {
      cliSourceDir,
      integrationTargets: ['claude', 'opencode', 'codex'],
      integrationScope: 'home',
      homeDir: controlledHome,
    });

    assert.deepEqual(result.integrationInstallsRequested, [
      { target: 'claude', scope: 'home' },
      { target: 'opencode', scope: 'home' },
      { target: 'codex', scope: 'home' },
    ]);
    assert.ok(
      fs.existsSync(path.join(controlledHome, '.claude', 'skills', 'consider', 'SKILL.md'))
    );
    assert.ok(
      fs.existsSync(path.join(controlledHome, '.opencode', 'skills', 'consider', 'SKILL.md'))
    );
    assert.ok(
      fs.existsSync(path.join(controlledHome, '.codex', 'skills', 'consider', 'SKILL.md'))
    );
    assert.ok(
      fs.existsSync(
        path.join(controlledHome, '.codex', 'skills', 'consider', 'agents', 'openai.yaml')
      )
    );
    assert.ok(!fs.existsSync(path.join(projectRoot, '.claude')));
    assert.ok(!fs.existsSync(path.join(projectRoot, '.opencode')));
    assert.ok(!fs.existsSync(path.join(projectRoot, '.codex')));
  });

  it('supports per-integration install scopes in a single setup run', () => {
    const controlledHome = path.join(projectRoot, 'fake-home');
    fs.mkdirSync(controlledHome, { recursive: true });

    const result = runSetupAgentIntegration(projectRoot, {
      cliSourceDir,
      integrationInstalls: [
        { target: 'claude', scope: 'project' },
        { target: 'opencode', scope: 'home' },
        { target: 'codex', scope: 'home' },
      ],
      homeDir: controlledHome,
    });

    assert.equal(result.integrationTargetsRequested.length, 3);
    assert.deepEqual(result.integrationInstallsRequested, [
      { target: 'claude', scope: 'project' },
      { target: 'opencode', scope: 'home' },
      { target: 'codex', scope: 'home' },
    ]);
    assert.ok(
      fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'consider', 'SKILL.md'))
    );
    assert.ok(
      fs.existsSync(path.join(controlledHome, '.opencode', 'skills', 'consider', 'SKILL.md'))
    );
    assert.ok(
      fs.existsSync(path.join(controlledHome, '.codex', 'skills', 'consider', 'SKILL.md'))
    );
    assert.ok(!fs.existsSync(path.join(projectRoot, '.opencode')));
    assert.ok(!fs.existsSync(path.join(projectRoot, '.codex')));
  });

  it('writes correctly formatted skill files for each selected agent', () => {
    runSetupAgentIntegration(projectRoot, {
      cliSourceDir,
      integrationTargets: ['claude', 'opencode', 'codex'],
    });

    const claudeSkill = read('.claude/skills/consider/SKILL.md', projectRoot);
    const openCodeSkill = read('.opencode/skills/consider/SKILL.md', projectRoot);
    const codexSkill = read('.codex/skills/consider/SKILL.md', projectRoot);
    const codexOpenAiMetadata = read(
      '.codex/skills/consider/agents/openai.yaml',
      projectRoot
    );

    assertHasSkillFrontmatter(claudeSkill);
    assertHasSkillFrontmatter(openCodeSkill);
    assertHasSkillFrontmatter(codexSkill);
    assertHasCodexOpenAiMetadata(codexOpenAiMetadata);
    assert.ok(
      codexSkill.includes(
        'Do not edit code unless there is a clear, explicit instruction to change code (in the thread or main chat).'
      )
    );
    assert.ok(
      codexSkill.includes(
        'Default to NOT resolving threads unless closure is explicit and complete.'
      )
    );
  });

  it('tracks installed skill locations in .consider/config.json', () => {
    const controlledHome = path.join(projectRoot, 'fake-home');
    fs.mkdirSync(controlledHome, { recursive: true });

    runSetupAgentIntegration(projectRoot, {
      cliSourceDir,
      integrationInstalls: [
        { target: 'claude', scope: 'project' },
        { target: 'codex', scope: 'home' },
      ],
      homeDir: controlledHome,
    });

    const config = readJson('.consider/config.json', projectRoot);
    assert.equal(config.version, 1);
    assert.ok(Array.isArray(config.trackedSkillInstalls));
    assert.ok(
      config.trackedSkillInstalls.some(
        (entry) =>
          entry.target === 'claude' &&
          entry.scope === 'project' &&
          entry.path.endsWith(path.join('.claude', 'skills', 'consider', 'SKILL.md'))
      )
    );
    assert.ok(
      config.trackedSkillInstalls.some(
        (entry) =>
          entry.target === 'codex' &&
          entry.scope === 'home' &&
          entry.path.endsWith(path.join('.codex', 'skills', 'consider', 'SKILL.md'))
      )
    );
  });

  it('deploys a runnable CLI in package type=module projects', () => {
    const realCliSourceDir = path.join(ROOT, 'cli');
    writeFile(projectRoot, 'package.json', '{"type":"module"}\n');

    const result = runSetupAgentIntegration(projectRoot, {
      cliSourceDir: realCliSourceDir,
    });

    assert.ok(result.cliCopied.length >= 5);
    const run = require('child_process').spawnSync(
      path.join(projectRoot, '.consider', 'bin', 'consider-cli'),
      ['summary'],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
      }
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(
      run.stdout.includes('No comments.') ||
      run.stdout.includes('Open comments: 0')
    );
  });

  it('is idempotent for .gitignore and codex skill file with explicit targets', () => {
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
    assert.equal(countOccurrences(gitignore, '.consider/'), 1);

    const codexSkill = read('.codex/skills/consider/SKILL.md', projectRoot);
    assertHasSkillFrontmatter(codexSkill);
    assert.equal(countOccurrences(codexSkill, '\nname: consider\n'), 1);
  });

  it('uninstalls tracked skills, removes gitignore entry, and deletes .consider by default', () => {
    const controlledHome = path.join(projectRoot, 'fake-home');
    fs.mkdirSync(controlledHome, { recursive: true });

    runSetupAgentIntegration(projectRoot, {
      cliSourceDir,
      integrationInstalls: [
        { target: 'claude', scope: 'project' },
        { target: 'opencode', scope: 'home' },
      ],
      homeDir: controlledHome,
    });

    const result = runUninstallAgentIntegration(projectRoot, {
      homeDir: controlledHome,
      removeConsiderDir: true,
      removeGitignoreEntry: true,
    });

    assert.equal(result.configFound, true);
    assert.equal(result.considerDirRemoved, true);
    assert.equal(result.gitignoreUpdated, true);
    assert.equal(result.skillsRemoved.length, 2);
    assert.ok(!fs.existsSync(path.join(projectRoot, '.consider')));
    assert.ok(!fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'consider')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.claude')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.claude', 'skills')));
    assert.ok(!fs.existsSync(path.join(controlledHome, '.opencode', 'skills', 'consider')));
    assert.ok(fs.existsSync(path.join(controlledHome, '.opencode')));
    assert.ok(fs.existsSync(path.join(controlledHome, '.opencode', 'skills')));
    assert.equal(read('.gitignore', projectRoot).includes('.consider/'), false);
  });

  it('supports skills-only uninstall and preserves .consider data', () => {
    runSetupAgentIntegration(projectRoot, {
      cliSourceDir,
      integrationTargets: ['codex'],
    });

    const result = runUninstallAgentIntegration(projectRoot, {
      removeConsiderDir: false,
      removeGitignoreEntry: false,
    });

    assert.equal(result.considerDirRemoved, false);
    assert.equal(result.gitignoreSkipped, true);
    assert.ok(fs.existsSync(path.join(projectRoot, '.consider', 'store.json')));
    assert.ok(!fs.existsSync(path.join(projectRoot, '.codex', 'skills', 'consider')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.codex')));
    assert.ok(fs.existsSync(path.join(projectRoot, '.codex', 'skills')));
    const config = readJson('.consider/config.json', projectRoot);
    assert.deepEqual(config.trackedSkillInstalls, []);
  });

  it('falls back to skill discovery when config is missing', () => {
    const codexSkillPath = path.join(
      projectRoot,
      '.codex',
      'skills',
      'consider',
      'SKILL.md'
    );
    writeFile(
      projectRoot,
      path.join('.codex', 'skills', 'consider', 'SKILL.md'),
      [
        '---',
        'name: consider',
        'description: feedback test',
        '---',
        '',
        '# Consider',
        '',
      ].join('\n')
    );

    const result = runUninstallAgentIntegration(projectRoot, {
      removeConsiderDir: false,
      removeGitignoreEntry: false,
    });

    assert.equal(result.configFound, false);
    assert.equal(result.fallbackDetectionUsed, true);
    assert.equal(result.skillsRemoved.length, 1);
    assert.equal(result.skillsRemoved[0], path.normalize(codexSkillPath));
    assert.ok(!fs.existsSync(path.join(projectRoot, '.codex', 'skills', 'consider')));
  });

  it('detects existing integration footprints for guided setup defaults', () => {
    const controlledHome = path.join(projectRoot, 'fake-home');
    fs.mkdirSync(controlledHome, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(controlledHome, '.codex'), { recursive: true });

    const detection = detectAgentIntegrations(projectRoot, { homeDir: controlledHome });
    const targets = getDetectedIntegrationTargets(detection);

    assert.equal(detection.claudeDirExists, true);
    assert.equal(detection.openCodeDirExists, false);
    assert.equal(detection.codexDirExists, true);
    assert.equal(detection.agentsDirExists, false);
    assert.equal(detection.homeCodexDirExists, true);
    assert.equal(detection.homeAgentsDirExists, false);
    assert.equal(detection.noneDetected, false);
    assert.deepEqual(targets, ['claude', 'codex']);
  });
});
