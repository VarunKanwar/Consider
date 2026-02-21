import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emptyStore, storePath, storeDirectoryPath, writeStore } from './store';

const CLAUDE_SKILL_PATH = ['.claude', 'skills', 'consider', 'SKILL.md'];
const OPENCODE_SKILL_PATH = ['.opencode', 'skills', 'consider', 'SKILL.md'];
const CODEX_SKILL_PATH = ['.codex', 'skills', 'consider', 'SKILL.md'];
const CODEX_LEGACY_SKILL_PATH = ['.agents', 'skills', 'consider', 'SKILL.md'];
const SKILL_NAME = 'consider';
const SETUP_CONFIG_VERSION = 1;
const CONSIDER_DIR_NAME = '.consider';
const LEGACY_FEEDBACK_DIR_NAME = '.feedback';

const SKILL_DESCRIPTIONS: Record<SetupIntegrationTarget, string> = {
  claude:
    'Use when this repository has Consider enabled and you need to triage inline feedback, run consider-cli commands, or handle a shared threadID token.',
  opencode:
    'Use when this repository has Consider enabled and you need to triage inline feedback, run consider-cli commands, or handle a shared threadID token.',
  codex:
    'Use when this repository has Consider enabled and you need to triage inline feedback, run consider-cli commands, or handle a shared threadID token.',
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

export interface SetupTrackedSkillInstall extends SetupIntegrationInstall {
  path: string;
}

export interface SetupResult {
  considerDirCreated: boolean;
  legacyDirMigrated: boolean;
  binDirCreated: boolean;
  storeCreated: boolean;
  cliCopied: string[];
  gitignoreUpdated: boolean;
  gitignoreSkipped: boolean;
  skillsWritten: string[];
  detection: AgentDetection;
  integrationTargetsRequested: SetupIntegrationTarget[];
  integrationInstallsRequested: SetupIntegrationInstall[];
  trackedSkillInstalls: SetupTrackedSkillInstall[];
}

export interface UninstallOptions {
  removeConsiderDir?: boolean;
  removeGitignoreEntry?: boolean;
  homeDir?: string;
}

export interface UninstallResult {
  configFound: boolean;
  fallbackDetectionUsed: boolean;
  trackedSkillInstalls: SetupTrackedSkillInstall[];
  skillsRemoved: string[];
  skillsMissing: string[];
  considerDirRemoved: boolean;
  considerDirAbsent: boolean;
  legacyFeedbackDirRemoved: boolean;
  gitignoreUpdated: boolean;
  gitignoreSkipped: boolean;
}

interface SetupConfigFile {
  version: number;
  trackedSkillInstalls: SetupTrackedSkillInstall[];
  lastUpdatedAt: string;
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

function considerDirPath(projectRoot: string): string {
  return path.join(projectRoot, CONSIDER_DIR_NAME);
}

function legacyFeedbackDirPath(projectRoot: string): string {
  return path.join(projectRoot, LEGACY_FEEDBACK_DIR_NAME);
}

function configPath(projectRoot: string): string {
  const considerConfigPath = path.join(considerDirPath(projectRoot), 'config.json');
  if (fs.existsSync(considerConfigPath)) {
    return considerConfigPath;
  }

  const legacyConfigPath = path.join(legacyFeedbackDirPath(projectRoot), 'config.json');
  if (fs.existsSync(legacyConfigPath)) {
    return legacyConfigPath;
  }

  return path.join(storeDirectoryPath(projectRoot), 'config.json');
}

function migrateLegacyFeedbackDirectory(projectRoot: string): boolean {
  const considerDir = considerDirPath(projectRoot);
  const legacyDir = legacyFeedbackDirPath(projectRoot);
  if (fs.existsSync(considerDir) || !fs.existsSync(legacyDir)) {
    return false;
  }
  fs.renameSync(legacyDir, considerDir);
  return true;
}

function emptySetupConfig(): SetupConfigFile {
  return {
    version: SETUP_CONFIG_VERSION,
    trackedSkillInstalls: [],
    lastUpdatedAt: new Date().toISOString(),
  };
}

function isSetupIntegrationTarget(value: unknown): value is SetupIntegrationTarget {
  return value === 'claude' || value === 'opencode' || value === 'codex';
}

function isSetupIntegrationScope(value: unknown): value is SetupIntegrationScope {
  return value === 'project' || value === 'home';
}

function normalizeTrackedSkillInstalls(
  installs: SetupTrackedSkillInstall[] | undefined
): SetupTrackedSkillInstall[] {
  const normalized: SetupTrackedSkillInstall[] = [];
  const seen = new Set<string>();

  for (const install of installs || []) {
    if (
      !install ||
      !isSetupIntegrationTarget(install.target) ||
      !isSetupIntegrationScope(install.scope) ||
      typeof install.path !== 'string' ||
      install.path.trim().length === 0
    ) {
      continue;
    }

    const normalizedPath = path.normalize(install.path);
    const key = `${install.target}:${install.scope}:${normalizedPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      target: install.target,
      scope: install.scope,
      path: normalizedPath,
    });
  }

  return normalized;
}

function readSetupConfig(projectRoot: string): SetupConfigFile {
  const p = configPath(projectRoot);
  if (!fs.existsSync(p)) {
    return emptySetupConfig();
  }

  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const data = JSON.parse(raw) as Partial<SetupConfigFile>;
    if (data.version !== SETUP_CONFIG_VERSION) {
      return emptySetupConfig();
    }
    return {
      version: SETUP_CONFIG_VERSION,
      trackedSkillInstalls: normalizeTrackedSkillInstalls(data.trackedSkillInstalls),
      lastUpdatedAt: typeof data.lastUpdatedAt === 'string'
        ? data.lastUpdatedAt
        : new Date().toISOString(),
    };
  } catch {
    return emptySetupConfig();
  }
}

function writeSetupConfig(projectRoot: string, config: SetupConfigFile): void {
  const p = configPath(projectRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const payload: SetupConfigFile = {
    version: SETUP_CONFIG_VERSION,
    trackedSkillInstalls: normalizeTrackedSkillInstalls(config.trackedSkillInstalls),
    lastUpdatedAt: config.lastUpdatedAt || new Date().toISOString(),
  };
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, p);
}

function mergeTrackedSkillInstalls(
  existing: SetupTrackedSkillInstall[],
  next: SetupTrackedSkillInstall[]
): SetupTrackedSkillInstall[] {
  return normalizeTrackedSkillInstalls([...existing, ...next]);
}

function ensureGitignoreEntry(projectRoot: string): boolean {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const existing = fs.existsSync(gitignorePath)
    ? normalizeNewline(fs.readFileSync(gitignorePath, 'utf-8'))
    : '';

  const lines = existing.length > 0 ? existing.split('\n') : [];
  const hasConsiderEntry = lines.some((line) => {
    const trimmed = line.trim();
    return trimmed === '.consider/' || trimmed === '.consider';
  });

  const withoutLegacyEntries = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '.feedback/' && trimmed !== '.feedback';
  });
  const needsLegacyCleanup = withoutLegacyEntries.length !== lines.length;

  if (hasConsiderEntry && !needsLegacyCleanup) {
    return false;
  }

  const nextLines = hasConsiderEntry
    ? withoutLegacyEntries
    : [...withoutLegacyEntries, '.consider/'];
  const next = trimTrailingBlankLines(nextLines.join('\n'));
  const separator = next.length > 0 ? '\n' : '';
  fs.writeFileSync(gitignorePath, `${next}${separator}`, 'utf-8');
  return true;
}

function removeGitignoreEntry(projectRoot: string): boolean {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    return false;
  }

  const existing = normalizeNewline(fs.readFileSync(gitignorePath, 'utf-8'));
  const lines = existing.length > 0 ? existing.split('\n') : [];
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '.consider/' &&
      trimmed !== '.consider' &&
      trimmed !== '.feedback/' &&
      trimmed !== '.feedback';
  });

  if (filtered.length === lines.length) {
    return false;
  }

  const next = trimTrailingBlankLines(filtered.join('\n'));
  const final = next.length > 0 ? `${next}\n` : '';
  fs.writeFileSync(gitignorePath, final, 'utf-8');
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

function knownSkillInstallCandidates(
  projectRoot: string,
  homeDir: string
): SetupTrackedSkillInstall[] {
  return [
    {
      target: 'claude',
      scope: 'project',
      path: path.join(projectRoot, ...CLAUDE_SKILL_PATH),
    },
    {
      target: 'claude',
      scope: 'home',
      path: path.join(homeDir, ...CLAUDE_SKILL_PATH),
    },
    {
      target: 'opencode',
      scope: 'project',
      path: path.join(projectRoot, ...OPENCODE_SKILL_PATH),
    },
    {
      target: 'opencode',
      scope: 'home',
      path: path.join(homeDir, ...OPENCODE_SKILL_PATH),
    },
    {
      target: 'codex',
      scope: 'project',
      path: path.join(projectRoot, ...CODEX_SKILL_PATH),
    },
    {
      target: 'codex',
      scope: 'home',
      path: path.join(homeDir, ...CODEX_SKILL_PATH),
    },
    // Legacy Codex location support for uninstall fallback.
    {
      target: 'codex',
      scope: 'project',
      path: path.join(projectRoot, ...CODEX_LEGACY_SKILL_PATH),
    },
    {
      target: 'codex',
      scope: 'home',
      path: path.join(homeDir, ...CODEX_LEGACY_SKILL_PATH),
    },
  ];
}

function looksLikeConsiderSkill(skillPath: string): boolean {
  if (!fs.existsSync(skillPath)) {
    return false;
  }
  try {
    const raw = fs.readFileSync(skillPath, 'utf-8');
    return raw.includes('\nname: consider\n') && raw.includes('# Consider');
  } catch {
    return false;
  }
}

function detectInstalledSkillsFallback(
  projectRoot: string,
  homeDir: string
): SetupTrackedSkillInstall[] {
  const detected: SetupTrackedSkillInstall[] = [];
  for (const install of knownSkillInstallCandidates(projectRoot, homeDir)) {
    if (looksLikeConsiderSkill(install.path)) {
      detected.push(install);
    }
  }
  return normalizeTrackedSkillInstalls(detected);
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
# Consider

You are configured with Consider inline review comments for this repository.
Use the CLI in \`.consider/bin/consider-cli\` to read and reply to located feedback.

## Trigger Cues

- Developer asks you to check Consider comments, run \`consider-cli\`, or address inline feedback.
- Developer shares \`threadID: <comment-id>\` in chat.

## Workflow

1. Before starting implementation, run:
   - \`.consider/bin/consider-cli summary\`
2. If there are no open comments, say so briefly and continue the main task.
3. If open comments exist, inspect them:
   - \`.consider/bin/consider-cli list\`
   - \`.consider/bin/consider-cli context <comment-id>\`
4. If the developer shares \`threadID: <comment-id>\`, fetch that exact thread:
   - \`.consider/bin/consider-cli thread <comment-id>\`
5. Reply directly in the thread:
   - \`.consider/bin/consider-cli reply <comment-id> --message "..." \`
6. Default to leaving threads open. Resolve only when both are true:
   - the issue is fully addressed,
   - the discussion is clearly at an end.
   - \`.consider/bin/consider-cli resolve <comment-id>\`
7. Reopen if follow-up work remains:
   - \`.consider/bin/consider-cli unresolve <comment-id>\`

## Conventions

- Default to conversational handling first: read feedback, reply, and clarify before editing code.
- Default to NOT resolving threads unless closure is explicit and complete.
- Treat \`workflow=open\` comments as review items to triage, not automatic edit instructions.
- Treat \`anchor=stale\` comments as potentially outdated: flag in main chat before acting.
- Treat \`anchor=orphaned\` comments as file-move/delete follow-up.
- Do not edit code unless there is a clear, explicit instruction to change code (in the thread or main chat).
- For each comment, choose one primary response channel:
  - Use the thread for localized feedback, clarifications, and brief acknowledgements.
  - Use the main chat for cross-cutting decisions, tradeoffs, or direction changes.
- Avoid duplicating full responses in both places; if escalating to main chat, leave a short thread pointer.
- If a comment is informational or preference-only, prefer a brief in-thread acknowledgement and no code edits.
- The source-of-truth store is \`.consider/store.json\`; use the CLI unless debugging.

## Failure Handling

- If CLI reports store busy/conflict, retry once before escalating.
- If CLI reports comment not found, rerun \`list\` and ask for a refreshed \`threadID\` if needed.
- If \`context\` reports orphaned/missing file, flag it in main chat and ask whether to keep open, resolve, or remap.

## Quick Reference

- \`.consider/bin/consider-cli summary [--json]\`
- \`.consider/bin/consider-cli list [--workflow open|resolved|all] [--anchor anchored|stale|orphaned|all] [--unseen] [--file <path>] [--json]\`
- \`.consider/bin/consider-cli thread <comment-id> [--json]\`
- \`.consider/bin/consider-cli reply <comment-id> --message "..." \`
- \`.consider/bin/consider-cli resolve <comment-id>\`
- \`.consider/bin/consider-cli unresolve <comment-id>\`
`;
}

function buildCodexOpenAiMetadata(): string {
  return [
    'interface:',
    '  display_name: "Consider"',
    '  short_description: "Review and reply to inline Consider threads"',
    '  default_prompt: "Use $consider to review open Consider comments, reply in thread, and only resolve when the issue is fully addressed and discussion is complete."',
    '',
  ].join('\n');
}

function writeCodexOpenAiMetadata(skillPath: string): string {
  const skillDir = path.dirname(skillPath);
  const agentsDir = path.join(skillDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const metadataPath = path.join(agentsDir, 'openai.yaml');
  fs.writeFileSync(metadataPath, buildCodexOpenAiMetadata(), 'utf-8');
  return metadataPath;
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
  destinationConsiderDir: string,
  destinationBinDir: string
): string[] {
  const files = ['consider-cli', 'consider-cli.js'];
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
  const cjsDestination = path.join(destinationBinDir, 'consider-cli.cjs');
  fs.copyFileSync(path.join(destinationBinDir, 'consider-cli.js'), cjsDestination);
  copied.push(cjsDestination);

  const launcherPath = path.join(destinationBinDir, 'consider-cli');
  fs.writeFileSync(
    launcherPath,
    '#!/bin/sh\nexec node "$(dirname "$0")/consider-cli.cjs" "$@"\n',
    'utf-8'
  );
  const binPackageJsonPath = path.join(destinationBinDir, 'package.json');
  fs.writeFileSync(
    binPackageJsonPath,
    '{\n  "type": "commonjs"\n}\n',
    'utf-8'
  );
  copied.push(binPackageJsonPath);

  // The CLI depends on shared runtime modules relative to .consider/bin.
  const sharedSourceDir = path.resolve(cliSourceDir, '..', 'shared');
  const sharedDestinationDir = path.join(destinationConsiderDir, 'shared');
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

function removeTrackedSkillInstall(install: SetupTrackedSkillInstall): boolean {
  const skillPath = path.normalize(install.path);
  if (!fs.existsSync(skillPath)) {
    return false;
  }

  const skillDir = path.dirname(skillPath);
  fs.rmSync(skillDir, { recursive: true, force: true });
  return true;
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
  const legacyDirMigrated = migrateLegacyFeedbackDirectory(projectRoot);
  const considerDir = considerDirPath(projectRoot);
  const considerDirCreated = ensureDirectory(considerDir);
  const binDir = path.join(considerDir, 'bin');
  const binDirCreated = ensureDirectory(binDir);

  const sp = storePath(projectRoot);
  const storeCreated = !fs.existsSync(sp);
  if (storeCreated) {
    writeStore(projectRoot, emptyStore());
  }

  const cliCopied = copyCli(options.cliSourceDir, considerDir, binDir);
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
  const trackedSkillInstallsWritten: SetupTrackedSkillInstall[] = [];

  for (const install of integrationInstallsRequested) {
    const skillBaseDir = install.scope === 'home'
      ? options.homeDir ?? os.homedir()
      : projectRoot;

    if (install.target === 'claude') {
      const skillPath = writeSkillFile(skillBaseDir, CLAUDE_SKILL_PATH, 'claude');
      skillsWritten.push(skillPath);
      trackedSkillInstallsWritten.push({
        target: 'claude',
        scope: install.scope,
        path: skillPath,
      });
      continue;
    }
    if (install.target === 'opencode') {
      const skillPath = writeSkillFile(skillBaseDir, OPENCODE_SKILL_PATH, 'opencode');
      skillsWritten.push(skillPath);
      trackedSkillInstallsWritten.push({
        target: 'opencode',
        scope: install.scope,
        path: skillPath,
      });
      continue;
    }
    if (install.target === 'codex') {
      const skillPath = writeSkillFile(skillBaseDir, CODEX_SKILL_PATH, 'codex');
      writeCodexOpenAiMetadata(skillPath);
      skillsWritten.push(skillPath);
      trackedSkillInstallsWritten.push({
        target: 'codex',
        scope: install.scope,
        path: skillPath,
      });
    }
  }

  const setupConfig = readSetupConfig(projectRoot);
  const trackedSkillInstalls = mergeTrackedSkillInstalls(
    setupConfig.trackedSkillInstalls,
    trackedSkillInstallsWritten
  );
  writeSetupConfig(projectRoot, {
    version: SETUP_CONFIG_VERSION,
    trackedSkillInstalls,
    lastUpdatedAt: new Date().toISOString(),
  });

  return {
    considerDirCreated,
    legacyDirMigrated,
    binDirCreated,
    storeCreated,
    cliCopied,
    gitignoreUpdated,
    gitignoreSkipped,
    skillsWritten,
    detection,
    integrationTargetsRequested,
    integrationInstallsRequested,
    trackedSkillInstalls,
  };
}

export function runUninstallAgentIntegration(
  projectRoot: string,
  options: UninstallOptions = {}
): UninstallResult {
  const homeDir = options.homeDir ?? os.homedir();
  const removeConsiderDir = options.removeConsiderDir ?? true;
  const shouldRemoveGitignoreEntry = options.removeGitignoreEntry ?? true;

  const considerDir = considerDirPath(projectRoot);
  const considerDirExists = fs.existsSync(considerDir);
  const legacyFeedbackDir = legacyFeedbackDirPath(projectRoot);
  const legacyFeedbackDirExists = fs.existsSync(legacyFeedbackDir);
  const configFilePath = configPath(projectRoot);
  const configFound = fs.existsSync(configFilePath);

  const setupConfig = readSetupConfig(projectRoot);
  let trackedSkillInstalls = setupConfig.trackedSkillInstalls;
  let fallbackDetectionUsed = false;

  if (trackedSkillInstalls.length === 0) {
    trackedSkillInstalls = detectInstalledSkillsFallback(projectRoot, homeDir);
    fallbackDetectionUsed = trackedSkillInstalls.length > 0;
  }

  const skillsRemoved: string[] = [];
  const skillsMissing: string[] = [];

  for (const install of trackedSkillInstalls) {
    if (removeTrackedSkillInstall(install)) {
      skillsRemoved.push(path.normalize(install.path));
    } else {
      skillsMissing.push(path.normalize(install.path));
    }
  }

  const gitignoreUpdated = shouldRemoveGitignoreEntry
    ? removeGitignoreEntry(projectRoot)
    : false;
  const gitignoreSkipped = !shouldRemoveGitignoreEntry;

  let considerDirRemoved = false;
  const considerDirAbsent = !considerDirExists;
  if (removeConsiderDir && considerDirExists) {
    fs.rmSync(considerDir, { recursive: true, force: true });
    considerDirRemoved = true;
  }

  let legacyFeedbackDirRemoved = false;
  if (removeConsiderDir && legacyFeedbackDirExists) {
    fs.rmSync(legacyFeedbackDir, { recursive: true, force: true });
    legacyFeedbackDirRemoved = true;
  }

  if (!removeConsiderDir && configFound) {
    const removedPaths = new Set(
      trackedSkillInstalls.map((install) => path.normalize(install.path))
    );
    const remainingTracked = setupConfig.trackedSkillInstalls.filter(
      (install) => !removedPaths.has(path.normalize(install.path))
    );
    writeSetupConfig(projectRoot, {
      version: SETUP_CONFIG_VERSION,
      trackedSkillInstalls: remainingTracked,
      lastUpdatedAt: new Date().toISOString(),
    });
  }

  return {
    configFound,
    fallbackDetectionUsed,
    trackedSkillInstalls,
    skillsRemoved,
    skillsMissing,
    considerDirRemoved,
    considerDirAbsent,
    legacyFeedbackDirRemoved,
    gitignoreUpdated,
    gitignoreSkipped,
  };
}
