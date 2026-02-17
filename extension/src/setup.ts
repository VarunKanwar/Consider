import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emptyStore, storePath, writeStore } from './store';

const CLAUDE_SKILL_PATH = ['.claude', 'skills', 'feedback-loop', 'SKILL.md'];
const OPENCODE_SKILL_PATH = ['.opencode', 'skills', 'feedback-loop', 'SKILL.md'];
const CODEX_SKILL_PATH = ['.codex', 'skills', 'feedback-loop', 'SKILL.md'];
const SKILL_NAME = 'feedback-loop';

const SKILL_DESCRIPTIONS: Record<SetupIntegrationTarget, string> = {
  claude:
    'Use when this repository has Feedback Loop enabled and you need to review, reply to, or resolve inline feedback via the feedback CLI.',
  opencode:
    'Use when this repository has Feedback Loop enabled and you need to review, reply to, or resolve inline feedback via the feedback CLI.',
  codex:
    'Use when this repository has Feedback Loop enabled and you need to review, reply to, or resolve inline feedback via the feedback CLI.',
};

export interface AgentDetection {
  claudeDirExists: boolean;
  openCodeDirExists: boolean;
  codexDirExists: boolean;
  agentsDirExists: boolean;
  homeClaudeDirExists: boolean;
  homeOpenCodeDirExists: boolean;
  homeCodexDirExists: boolean;
  homeAgentsDirExists: boolean;
  noneDetected: boolean;
}

export interface AgentDetectionOptions {
  homeDir?: string;
}

export interface SetupOptions {
  cliSourceDir: string;
  addGitignoreEntry?: boolean;
  integrationTargets?: SetupIntegrationTarget[];
  integrationInstalls?: SetupIntegrationInstall[];
  integrationScope?: SetupIntegrationScope;
  homeDir?: string;
}

export type SetupIntegrationTarget = 'claude' | 'opencode' | 'codex';
export type SetupIntegrationScope = 'project' | 'home';

export interface SetupIntegrationInstall {
  target: SetupIntegrationTarget;
  scope: SetupIntegrationScope;
}

export interface SetupResult {
  feedbackDirCreated: boolean;
  binDirCreated: boolean;
  storeCreated: boolean;
  cliCopied: string[];
  gitignoreUpdated: boolean;
  gitignoreSkipped: boolean;
  skillsWritten: string[];
  detection: AgentDetection;
  integrationTargetsRequested: SetupIntegrationTarget[];
  integrationInstallsRequested: SetupIntegrationInstall[];
}

function ensureDirectory(dirPath: string): boolean {
  if (fs.existsSync(dirPath)) {
    return false;
  }
  fs.mkdirSync(dirPath, { recursive: true });
  return true;
}

function normalizeNewline(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function trimTrailingBlankLines(content: string): string {
  return content.replace(/\n+$/g, '');
}

function ensureGitignoreEntry(projectRoot: string): boolean {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const existing = fs.existsSync(gitignorePath)
    ? normalizeNewline(fs.readFileSync(gitignorePath, 'utf-8'))
    : '';

  const lines = existing.length > 0 ? existing.split('\n') : [];
  const alreadyPresent = lines.some((line) => {
    const trimmed = line.trim();
    return trimmed === '.feedback/' || trimmed === '.feedback';
  });

  if (alreadyPresent) {
    return false;
  }

  const next = trimTrailingBlankLines(existing);
  const separator = next.length > 0 ? '\n' : '';
  fs.writeFileSync(gitignorePath, `${next}${separator}.feedback/\n`, 'utf-8');
  return true;
}

export function detectAgentIntegrations(
  projectRoot: string,
  options: AgentDetectionOptions = {}
): AgentDetection {
  const homeDir = options.homeDir ?? os.homedir();
  const claudeDirExists = fs.existsSync(path.join(projectRoot, '.claude'));
  const openCodeDirExists = fs.existsSync(path.join(projectRoot, '.opencode'));
  const codexDirExists = fs.existsSync(path.join(projectRoot, '.codex'));
  const agentsDirExists = fs.existsSync(path.join(projectRoot, '.agents'));
  const homeClaudeDirExists = fs.existsSync(path.join(homeDir, '.claude'));
  const homeOpenCodeDirExists = fs.existsSync(path.join(homeDir, '.opencode'));
  const homeCodexDirExists = fs.existsSync(path.join(homeDir, '.codex'));
  const homeAgentsDirExists = fs.existsSync(path.join(homeDir, '.agents'));
  const noneDetected = !claudeDirExists &&
    !openCodeDirExists &&
    !codexDirExists &&
    !agentsDirExists &&
    !homeClaudeDirExists &&
    !homeOpenCodeDirExists &&
    !homeCodexDirExists &&
    !homeAgentsDirExists;
  return {
    claudeDirExists,
    openCodeDirExists,
    codexDirExists,
    agentsDirExists,
    homeClaudeDirExists,
    homeOpenCodeDirExists,
    homeCodexDirExists,
    homeAgentsDirExists,
    noneDetected,
  };
}

export function getDetectedIntegrationTargets(
  detection: AgentDetection
): SetupIntegrationTarget[] {
  const targets: SetupIntegrationTarget[] = [];
  if (detection.claudeDirExists || detection.homeClaudeDirExists) {
    targets.push('claude');
  }
  if (detection.openCodeDirExists || detection.homeOpenCodeDirExists) {
    targets.push('opencode');
  }
  if (
    detection.codexDirExists ||
    detection.agentsDirExists ||
    detection.homeCodexDirExists ||
    detection.homeAgentsDirExists
  ) {
    targets.push('codex');
  }
  return targets;
}

function buildSkillMarkdown(target: SetupIntegrationTarget): string {
  const frontmatter = [
    '---',
    `name: ${SKILL_NAME}`,
    `description: ${SKILL_DESCRIPTIONS[target]}`,
    '---',
    '',
  ].join('\n');

  return `${frontmatter}
# Feedback Loop

You are configured with Feedback Loop inline review comments for this repository.
Use the CLI in \`.feedback/bin/feedback-cli\` to read and reply to located feedback.

## Workflow

1. Before starting implementation, run:
   - \`.feedback/bin/feedback-cli summary\`
2. If open comments exist, inspect them:
   - \`.feedback/bin/feedback-cli list\`
   - \`.feedback/bin/feedback-cli context <comment-id>\`
3. Reply directly in the thread:
   - \`.feedback/bin/feedback-cli reply <comment-id> --message "..." \`
4. Resolve once complete:
   - \`.feedback/bin/feedback-cli resolve <comment-id>\`

## Conventions

- Treat \`open\` comments as actionable review items.
- Treat \`stale\` comments as potentially outdated: flag in main chat before acting.
- Treat \`orphaned\` comments as file-move/delete follow-up.
- If a comment is informational or preference-only (no explicit change request), prefer a thread reply without making code edits.
- Keep file-specific discussion in comment threads; use main chat for cross-cutting decisions.
- The source-of-truth store is \`.feedback/store.json\`; use the CLI unless debugging.

## Commands

- \`.feedback/bin/feedback-cli list [--status open|resolved|stale|orphaned|all] [--file <path>] [--json]\`
- \`.feedback/bin/feedback-cli get <comment-id> [--json]\`
- \`.feedback/bin/feedback-cli context <comment-id> [--lines N] [--json]\`
- \`.feedback/bin/feedback-cli reply <comment-id> --message "..." \`
- \`.feedback/bin/feedback-cli resolve <comment-id>\`
- \`.feedback/bin/feedback-cli summary [--json]\`
`;
}

function writeSkillFile(
  baseDir: string,
  relativeSegments: string[],
  target: SetupIntegrationTarget
): string {
  const targetPath = path.join(baseDir, ...relativeSegments);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buildSkillMarkdown(target), 'utf-8');
  return targetPath;
}

function copyCli(
  cliSourceDir: string,
  destinationFeedbackDir: string,
  destinationBinDir: string
): string[] {
  const files = ['feedback-cli', 'feedback-cli.js'];
  const copied: string[] = [];

  for (const file of files) {
    const source = path.join(cliSourceDir, file);
    if (!fs.existsSync(source)) {
      throw new Error(`CLI source file not found: ${source}`);
    }
    const destination = path.join(destinationBinDir, file);
    fs.copyFileSync(source, destination);
    copied.push(destination);
  }

  // Always ship a .cjs runtime entrypoint so the CLI works in repos with
  // package.json type=module.
  const cjsDestination = path.join(destinationBinDir, 'feedback-cli.cjs');
  fs.copyFileSync(path.join(destinationBinDir, 'feedback-cli.js'), cjsDestination);
  copied.push(cjsDestination);

  const launcherPath = path.join(destinationBinDir, 'feedback-cli');
  fs.writeFileSync(
    launcherPath,
    '#!/bin/sh\nexec node "$(dirname "$0")/feedback-cli.cjs" "$@"\n',
    'utf-8'
  );
  const binPackageJsonPath = path.join(destinationBinDir, 'package.json');
  fs.writeFileSync(
    binPackageJsonPath,
    '{\n  "type": "commonjs"\n}\n',
    'utf-8'
  );
  copied.push(binPackageJsonPath);

  // The CLI depends on shared runtime modules relative to .feedback/bin.
  const sharedSourceDir = path.resolve(cliSourceDir, '..', 'shared');
  const sharedDestinationDir = path.join(destinationFeedbackDir, 'shared');
  fs.mkdirSync(sharedDestinationDir, { recursive: true });
  for (const file of ['store.js', 'reconcile.js']) {
    const source = path.join(sharedSourceDir, file);
    if (!fs.existsSync(source)) {
      throw new Error(`Shared source file not found: ${source}`);
    }
    const destination = path.join(sharedDestinationDir, file);
    fs.copyFileSync(source, destination);
    copied.push(destination);
  }
  const sharedPackageJsonPath = path.join(sharedDestinationDir, 'package.json');
  fs.writeFileSync(
    sharedPackageJsonPath,
    '{\n  "type": "commonjs"\n}\n',
    'utf-8'
  );
  copied.push(sharedPackageJsonPath);

  fs.chmodSync(launcherPath, 0o755);
  return copied;
}

function normalizeIntegrationTargets(
  targets: SetupIntegrationTarget[] | undefined
): SetupIntegrationTarget[] {
  const allowed: SetupIntegrationTarget[] = ['claude', 'opencode', 'codex'];
  const seen = new Set<SetupIntegrationTarget>();
  const normalized: SetupIntegrationTarget[] = [];

  for (const target of targets || []) {
    if (!allowed.includes(target) || seen.has(target)) {
      continue;
    }
    seen.add(target);
    normalized.push(target);
  }

  return normalized;
}

function normalizeIntegrationInstalls(
  installs: SetupIntegrationInstall[] | undefined,
  targets: SetupIntegrationTarget[] | undefined,
  integrationScope: SetupIntegrationScope | undefined
): SetupIntegrationInstall[] {
  const normalized: SetupIntegrationInstall[] = [];
  const seen = new Set<SetupIntegrationTarget>();

  if (installs && installs.length > 0) {
    for (const install of installs) {
      if (seen.has(install.target)) {
        continue;
      }
      seen.add(install.target);
      normalized.push({
        target: install.target,
        scope: install.scope,
      });
    }
    return normalized;
  }

  const fallbackScope: SetupIntegrationScope = integrationScope ?? 'project';
  for (const target of normalizeIntegrationTargets(targets)) {
    normalized.push({ target, scope: fallbackScope });
  }

  return normalized;
}

export function runSetupAgentIntegration(
  projectRoot: string,
  options: SetupOptions
): SetupResult {
  const feedbackDir = path.join(projectRoot, '.feedback');
  const feedbackDirCreated = ensureDirectory(feedbackDir);
  const binDir = path.join(feedbackDir, 'bin');
  const binDirCreated = ensureDirectory(binDir);

  const sp = storePath(projectRoot);
  const storeCreated = !fs.existsSync(sp);
  if (storeCreated) {
    writeStore(projectRoot, emptyStore());
  }

  const cliCopied = copyCli(options.cliSourceDir, feedbackDir, binDir);
  const addGitignoreEntry = options.addGitignoreEntry ?? true;
  const gitignoreUpdated = addGitignoreEntry
    ? ensureGitignoreEntry(projectRoot)
    : false;
  const gitignoreSkipped = !addGitignoreEntry;

  const detection = detectAgentIntegrations(projectRoot, { homeDir: options.homeDir });
  const integrationInstallsRequested = normalizeIntegrationInstalls(
    options.integrationInstalls,
    options.integrationTargets,
    options.integrationScope
  );
  const integrationTargetsRequested = integrationInstallsRequested.map(
    (install) => install.target
  );

  const skillsWritten: string[] = [];

  for (const install of integrationInstallsRequested) {
    const skillBaseDir = install.scope === 'home'
      ? options.homeDir ?? os.homedir()
      : projectRoot;

    if (install.target === 'claude') {
      skillsWritten.push(
        writeSkillFile(skillBaseDir, CLAUDE_SKILL_PATH, 'claude')
      );
      continue;
    }
    if (install.target === 'opencode') {
      skillsWritten.push(
        writeSkillFile(skillBaseDir, OPENCODE_SKILL_PATH, 'opencode')
      );
      continue;
    }
    if (install.target === 'codex') {
      skillsWritten.push(
        writeSkillFile(skillBaseDir, CODEX_SKILL_PATH, 'codex')
      );
    }
  }

  return {
    feedbackDirCreated,
    binDirCreated,
    storeCreated,
    cliCopied,
    gitignoreUpdated,
    gitignoreSkipped,
    skillsWritten,
    detection,
    integrationTargetsRequested,
    integrationInstallsRequested,
  };
}
