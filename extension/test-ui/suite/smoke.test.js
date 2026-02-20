const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  By,
  EditorView,
  InputBox,
  TextEditor,
  VSBrowser,
  WebView,
  Workbench,
  until,
} = require('vscode-extension-tester');

const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const WAIT_TIMEOUT_MS = IS_CI ? 90000 : 20000;
const UI_ACTION_TIMEOUT_MS = IS_CI ? 90000 : 20000;
const INPUT_TIMEOUT_MS = IS_CI ? 30000 : 10000;
const RETRY_ATTEMPTS = IS_CI ? 2 : 1;
const EXTERNAL_WRITE_SETTLE_MS = IS_CI ? 1200 : 700;

function storePath(workspacePath) {
  return path.join(workspacePath, '.consider', 'store.json');
}

function archivePath(workspacePath) {
  return path.join(workspacePath, '.consider', 'archive.json');
}

function loadStore(workspacePath) {
  return JSON.parse(fs.readFileSync(storePath(workspacePath), 'utf-8'));
}

function removeIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function resetWorkspace(workspacePath) {
  removeIfExists(path.join(workspacePath, '.consider'));
  removeIfExists(path.join(workspacePath, '.gitignore'));
  removeIfExists(path.join(workspacePath, '.claude'));
  removeIfExists(path.join(workspacePath, '.opencode'));
  removeIfExists(path.join(workspacePath, '.codex'));
  removeIfExists(path.join(workspacePath, '.agents'));
  fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, 'src', 'sample.ts'),
    [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
    ].join('\n'),
    'utf-8'
  );
}

function runCli(workspacePath, repoRoot, args) {
  const cliPath = path.join(repoRoot, 'cli', 'consider-cli.js');
  const result = cp.spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspacePath,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(
      `CLI failed (${args.join(' ')}):\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(description, attempts, run) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(500);
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${description} failed after ${attempts} attempt(s): ${message}`);
}

async function waitFor(condition, description, timeoutMs = WAIT_TIMEOUT_MS, intervalMs = 100) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await Promise.resolve(condition())) {
      return;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${description} (${timeoutMs}ms)`);
}

async function dismissSetupPromptIfPresent() {
  const workbench = new Workbench();
  const notifications = await workbench.getNotifications();
  for (const notification of notifications) {
    const message = await notification.getMessage();
    if (message.includes('Consider is installed for this workspace')) {
      try {
        await notification.takeAction('Later');
      } catch {
        await notification.dismiss();
      }
    }
  }
}

async function openSampleEditor(workspacePath, line = 1) {
  const sampleFilePath = path.join(workspacePath, 'src', 'sample.ts');
  const editorView = new EditorView();
  let openedTitle;
  await withRetry('open sample.ts editor', RETRY_ATTEMPTS, async () => {
    await VSBrowser.instance.openResources(sampleFilePath);
    await waitFor(async () => {
      const titles = await editorView.getOpenEditorTitles();
      openedTitle = titles.find((title) => title.includes('sample.ts'));
      return typeof openedTitle === 'string';
    }, 'sample.ts editor tab to open');
    await editorView.openEditor(openedTitle);
  });
  const editor = new TextEditor();
  await editor.setCursor(line, 1);
  return editor;
}

function threadActionSelector(actionLabel) {
  return `//*[self::button or @role='button' or contains(@class,'monaco-button')][normalize-space()='${actionLabel}' or contains(@aria-label,'${actionLabel}') or contains(@title,'${actionLabel}')]`;
}

async function openFirstThreadFromGutter() {
  const driver = VSBrowser.instance.driver;
  const threadGlyph = await driver.wait(
    until.elementLocated(
      By.xpath(
        "//div[contains(@class,'margin-view-overlays')]//*[contains(@class,'comment-thread-unresolved')]"
      )
    ),
    UI_ACTION_TIMEOUT_MS
  );
  await driver.executeScript(
    "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'})",
    threadGlyph
  );
  await threadGlyph.click();
}

async function clickThreadAction(actionLabel) {
  const driver = VSBrowser.instance.driver;
  const action = await driver.wait(
    until.elementLocated(By.xpath(threadActionSelector(actionLabel))),
    UI_ACTION_TIMEOUT_MS
  );
  await action.click();
}

async function setupViaWebview() {
  const workbench = new Workbench();
  const editorView = new EditorView();
  await withRetry('open setup webview', RETRY_ATTEMPTS, async () => {
    await dismissSetupPromptIfPresent();
    await workbench.executeCommand('Consider: Setup');

    let setupTitle;
    await waitFor(async () => {
      const titles = await editorView.getOpenEditorTitles();
      setupTitle = titles.find((title) => title.includes('Consider: Setup'));
      return typeof setupTitle === 'string';
    }, 'setup webview tab');
    await editorView.openEditor(setupTitle);

    const webview = new WebView();
    await webview.switchToFrame();
    try {
      let submitButton;
      await waitFor(async () => {
        try {
          submitButton = await webview.findWebElement(By.css('#submit'));
          return true;
        } catch {
          return false;
        }
      }, 'setup submit button');
      await submitButton.click();
    } finally {
      await webview.switchBack();
    }
  });
}

async function addCommentViaCommand(commentBody) {
  const workbench = new Workbench();
  await workbench.executeCommand('Add Comment');
  const input = await InputBox.create(INPUT_TIMEOUT_MS);
  await input.setText(commentBody);
  await input.confirm();
}

async function uninstallFullViaCommand() {
  const workbench = new Workbench();
  await workbench.executeCommand('Consider: Uninstall');
  await withRetry('select uninstall quick pick', RETRY_ATTEMPTS, async () => {
    const options = await InputBox.create(INPUT_TIMEOUT_MS);
    await options.selectQuickPick('Full uninstall');
  });

  const driver = VSBrowser.instance.driver;
  const uninstallButton = await driver.wait(
    until.elementLocated(
      By.xpath(
        "//*[self::button or @role='button' or contains(@class,'monaco-button')][normalize-space()='Uninstall' or contains(@aria-label,'Uninstall')]"
      )
    ),
    UI_ACTION_TIMEOUT_MS
  );
  await uninstallButton.click();
}

describe('Consider UI smoke', function () {
  this.timeout(IS_CI ? 900000 : 240000);

  let workspacePath;
  let repoRoot;
  const lifecycleCommentBody = 'UI smoke lifecycle root comment';
  const lifecycleReplyBody = 'UI smoke external CLI reply';

  before(async function () {
    workspacePath = process.env.CONSIDER_UI_WORKSPACE;
    repoRoot = process.env.CONSIDER_UI_REPO_ROOT;
    assert.ok(workspacePath, 'CONSIDER_UI_WORKSPACE must be set.');
    assert.ok(repoRoot, 'CONSIDER_UI_REPO_ROOT must be set.');
    resetWorkspace(workspacePath);
    await dismissSetupPromptIfPresent();
  });

  beforeEach(async function () {
    await dismissSetupPromptIfPresent();
  });

  it('runs guided setup and scaffolds workspace artifacts', async function () {
    await setupViaWebview();
    await waitFor(
      () =>
        fs.existsSync(storePath(workspacePath)) &&
        fs.existsSync(path.join(workspacePath, '.consider', 'config.json')),
      'setup-created store and config files'
    );

    assert.ok(fs.existsSync(path.join(workspacePath, '.consider', 'config.json')));
    assert.ok(fs.existsSync(path.join(workspacePath, '.consider', 'bin', 'consider-cli')));
    assert.ok(fs.existsSync(path.join(workspacePath, '.consider', 'bin', 'consider-cli.cjs')));
    assert.ok(fs.existsSync(path.join(workspacePath, '.consider', 'shared', 'store.js')));

    const gitignore = fs.readFileSync(path.join(workspacePath, '.gitignore'), 'utf-8');
    assert.ok(gitignore.includes('.consider/'));
  });

  it('covers add-comment, CLI reply watcher, resolve/unresolve, and archive', async function () {
    await openSampleEditor(workspacePath, 1);
    await addCommentViaCommand(lifecycleCommentBody);

    let createdComment;
    await waitFor(() => {
      const store = loadStore(workspacePath);
      createdComment = store.comments.find((entry) => entry.body === lifecycleCommentBody);
      return Boolean(createdComment);
    }, 'new UI-added comment in store');
    assert.ok(createdComment, 'Expected UI-added comment in store.');
    assert.equal(createdComment.workflowState, 'open');
    assert.equal(createdComment.anchorState, 'anchored');

    // The extension suppresses store watcher events for ~500ms after writes.
    // Delay so the CLI write is treated as an external update.
    await delay(EXTERNAL_WRITE_SETTLE_MS);

    runCli(workspacePath, repoRoot, [
      'reply',
      createdComment.id,
      '--message',
      lifecycleReplyBody,
    ]);
    await waitFor(() => {
      const store = loadStore(workspacePath);
      const updated = store.comments.find((entry) => entry.id === createdComment.id);
      return Boolean(updated && updated.thread.length === 1);
    }, 'CLI reply persisted to store');

    await openFirstThreadFromGutter();
    const driver = VSBrowser.instance.driver;
    await driver.wait(
      until.elementLocated(
        By.xpath(`//*[contains(normalize-space(.), '${lifecycleReplyBody}')]`)
      ),
      UI_ACTION_TIMEOUT_MS
    );

    await clickThreadAction('Resolve');
    await waitFor(() => {
      const store = loadStore(workspacePath);
      const updated = store.comments.find((entry) => entry.id === createdComment.id);
      return updated && updated.workflowState === 'resolved';
    }, 'resolved workflow state');

    // Resolve was a local extension write; delay so the CLI write is observed
    // by the watcher as an external change.
    await delay(EXTERNAL_WRITE_SETTLE_MS);
    runCli(workspacePath, repoRoot, ['unresolve', createdComment.id]);
    await waitFor(() => {
      const store = loadStore(workspacePath);
      const updated = store.comments.find((entry) => entry.id === createdComment.id);
      return updated && updated.workflowState === 'open';
    }, 'reopened workflow state');

    await waitFor(async () => {
      const glyphs = await VSBrowser.instance.driver.findElements(
        By.xpath(
          "//div[contains(@class,'margin-view-overlays')]//*[contains(@class,'comment-thread-unresolved')]"
        )
      );
      return glyphs.length > 0;
    }, 'unresolved thread glyph after reopen');
    await openFirstThreadFromGutter();
    await clickThreadAction('Resolve');
    await waitFor(() => {
      const store = loadStore(workspacePath);
      const updated = store.comments.find((entry) => entry.id === createdComment.id);
      return updated && updated.workflowState === 'resolved';
    }, 'resolved workflow state before archive');

    const workbench = new Workbench();
    await workbench.executeCommand('Consider: Archive Resolved');
    await waitFor(
      () => fs.existsSync(archivePath(workspacePath)),
      'archive file creation after archive command'
    );

    const archived = JSON.parse(fs.readFileSync(archivePath(workspacePath), 'utf-8'));
    assert.ok(
      archived.comments.some((entry) => entry.comment?.id === createdComment.id),
      'Expected resolved comment to be moved to archive.'
    );

    const activeStore = loadStore(workspacePath);
    assert.ok(
      !activeStore.comments.some((entry) => entry.id === createdComment.id),
      'Expected resolved comment to be removed from active store.'
    );
  });

  it('runs full uninstall from the command flow', async function () {
    await uninstallFullViaCommand();

    await waitFor(
      () => !fs.existsSync(path.join(workspacePath, '.consider')),
      'consider directory removal after full uninstall'
    );

    const gitignorePath = path.join(workspacePath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
      assert.ok(!gitignore.includes('.consider/'));
      assert.ok(!gitignore.includes('.consider\n'));
    }
  });
});
