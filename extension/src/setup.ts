import * as fs from 'fs';
import * as path from 'path';
import { emptyStore, storePath, writeStore } from './store';

const CLAUDE_SKILL_PATH = ['.claude', 'skills', 'feedback-loop', 'SKILL.md'];
const OPENCODE_SKILL_PATH = ['.opencode', 'skills', 'feedback-loop', 'SKILL.md'];
const CODEX_SECTION_START = '<!-- feedback-loop:codex:start -->';
const CODEX_SECTION_END = '<!-- feedback-loop:codex:end -->';

export interface AgentDetection {
  claudeDirExists: boolean;
  openCodeDirExists: boolean;
  agentsMdExists: boolean;
  noneDetected: boolean;
}

export interface SetupOptions {
  cliSourceDir: string;
}

export interface SetupResult {
  feedbackDirCreated: boolean;
  binDirCreated: boolean;
  storeCreated: boolean;
  cliCopied: string[];
  gitignoreUpdated: boolean;
  skillsWritten: string[];
  codexSectionUpdated: boolean;
  detection: AgentDetection;
  usedFallbackToAllAgents: boolean;
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

function detectAgents(projectRoot: string): AgentDetection {
  const claudeDirExists = fs.existsSync(path.join(projectRoot, '.claude'));
  const openCodeDirExists = fs.existsSync(path.join(projectRoot, '.opencode'));
  const agentsMdExists = fs.existsSync(path.join(projectRoot, 'AGENTS.md'));
  const noneDetected = !claudeDirExists && !openCodeDirExists && !agentsMdExists;
  return { claudeDirExists, openCodeDirExists, agentsMdExists, noneDetected };
}

function buildSkillMarkdown(agentName: string): string {
  return `# Feedback Loop

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
- Keep file-specific discussion in comment threads; use main chat for cross-cutting decisions.
- The source-of-truth store is \`.feedback/store.json\`; use the CLI unless debugging.

## Commands

- \`.feedback/bin/feedback-cli list [--status open|resolved|stale|orphaned|all] [--file <path>] [--json]\`
- \`.feedback/bin/feedback-cli get <comment-id> [--json]\`
- \`.feedback/bin/feedback-cli context <comment-id> [--lines N] [--json]\`
- \`.feedback/bin/feedback-cli reply <comment-id> --message "..." \`
- \`.feedback/bin/feedback-cli resolve <comment-id>\`
- \`.feedback/bin/feedback-cli summary [--json]\`

Installed for: ${agentName}
`;
}

function buildCodexSection(): string {
  return `${CODEX_SECTION_START}
## Feedback Loop Integration

This project uses Feedback Loop for inline file-anchored review threads.

When asked to check feedback:

1. Run \`.feedback/bin/feedback-cli summary\`.
2. Run \`.feedback/bin/feedback-cli list\` (or \`--file <path>\` when scoped).
3. For each open comment, run \`.feedback/bin/feedback-cli context <comment-id>\`.
4. Reply with \`.feedback/bin/feedback-cli reply <comment-id> --message "..." \`.
5. Resolve with \`.feedback/bin/feedback-cli resolve <comment-id>\` once addressed.

State handling:

- \`open\`: process normally.
- \`stale\`: confirm with developer before applying potentially outdated changes.
- \`orphaned\`: file no longer exists; ask for re-anchor/move details.

Primary store path: \`.feedback/store.json\` (CLI preferred over direct editing).
${CODEX_SECTION_END}
`;
}

function upsertCodexSection(projectRoot: string): boolean {
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const existing = fs.existsSync(agentsPath)
    ? normalizeNewline(fs.readFileSync(agentsPath, 'utf-8'))
    : '';
  const section = buildCodexSection();

  let next = existing;
  const startIdx = existing.indexOf(CODEX_SECTION_START);
  const endIdx = existing.indexOf(CODEX_SECTION_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const afterEnd = endIdx + CODEX_SECTION_END.length;
    next = `${existing.slice(0, startIdx)}${section}${existing.slice(afterEnd)}`;
  } else {
    const trimmed = trimTrailingBlankLines(existing);
    const separator = trimmed.length > 0 ? '\n\n' : '';
    next = `${trimmed}${separator}${section}`;
  }

  if (next === existing) {
    return false;
  }
  fs.writeFileSync(agentsPath, next.endsWith('\n') ? next : `${next}\n`, 'utf-8');
  return true;
}

function writeSkillFile(projectRoot: string, relativeSegments: string[], agentName: string): string {
  const targetPath = path.join(projectRoot, ...relativeSegments);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buildSkillMarkdown(agentName), 'utf-8');
  return targetPath;
}

function copyCli(cliSourceDir: string, destinationBinDir: string): string[] {
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

  fs.chmodSync(path.join(destinationBinDir, 'feedback-cli'), 0o755);
  return copied;
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

  const cliCopied = copyCli(options.cliSourceDir, binDir);
  const gitignoreUpdated = ensureGitignoreEntry(projectRoot);

  const detection = detectAgents(projectRoot);
  const usedFallbackToAllAgents = detection.noneDetected;
  const configureClaude = detection.claudeDirExists || detection.noneDetected;
  const configureOpenCode = detection.openCodeDirExists || detection.noneDetected;
  const configureCodex = detection.agentsMdExists || detection.noneDetected;

  const skillsWritten: string[] = [];
  let codexSectionUpdated = false;

  if (configureClaude) {
    skillsWritten.push(
      writeSkillFile(projectRoot, CLAUDE_SKILL_PATH, 'Claude Code')
    );
  }

  if (configureOpenCode) {
    skillsWritten.push(
      writeSkillFile(projectRoot, OPENCODE_SKILL_PATH, 'OpenCode')
    );
  }

  if (configureCodex) {
    codexSectionUpdated = upsertCodexSection(projectRoot);
  }

  return {
    feedbackDirCreated,
    binDirCreated,
    storeCreated,
    cliCopied,
    gitignoreUpdated,
    skillsWritten,
    codexSectionUpdated,
    detection,
    usedFallbackToAllAgents,
  };
}

