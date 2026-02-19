const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  By,
  EditorView,
  TextEditor,
  VSBrowser,
  Workbench,
  until,
} = require('vscode-extension-tester');

function loadStore(workspacePath) {
  return JSON.parse(
    fs.readFileSync(path.join(workspacePath, '.feedback', 'store.json'), 'utf-8')
  );
}

async function waitFor(condition, description, timeoutMs = 15000, intervalMs = 100) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await Promise.resolve(condition())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

async function dismissSetupPromptIfPresent() {
  const workbench = new Workbench();
  const notifications = await workbench.getNotifications();
  for (const notification of notifications) {
    const message = await notification.getMessage();
    if (message.includes('Feedback Loop is installed for this workspace')) {
      try {
        await notification.takeAction('Later');
      } catch {
        await notification.dismiss();
      }
    }
  }
}

describe('Feedback Loop UI smoke', function () {
  this.timeout(180000);

  let workspacePath;
  const seededCommentBody = 'UI smoke seeded comment';
  const seededCommentId = 'c_ui_smoke_seed_1';

  before(async function () {
    workspacePath = process.env.FEEDBACK_LOOP_UI_WORKSPACE;
    assert.ok(workspacePath, 'FEEDBACK_LOOP_UI_WORKSPACE must be set.');
    const storePath = path.join(workspacePath, '.feedback', 'store.json');
    const now = new Date().toISOString();
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          version: 1,
          comments: [
            {
              id: seededCommentId,
              file: 'src/sample.ts',
              anchor: {
                startLine: 1,
                endLine: 1,
                contextBefore: [],
                contextAfter: [],
                targetContent: 'export function add(a: number, b: number): number {',
                contentHash: '',
                lastAnchorCheck: now,
              },
              workflowState: 'open',
              anchorState: 'anchored',
              createdAt: now,
              author: 'human',
              body: seededCommentBody,
              thread: [],
            },
          ],
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );
    await dismissSetupPromptIfPresent();
  });

  it('opens and resolves a seeded comment via UI interactions', async function () {
    const sampleFilePath = path.join(workspacePath, 'src', 'sample.ts');
    await VSBrowser.instance.openResources(sampleFilePath);
    const editorView = new EditorView();

    let openedTitle;
    await waitFor(async () => {
      const titles = await editorView.getOpenEditorTitles();
      openedTitle = titles.find((title) => title.includes('sample.ts'));
      return typeof openedTitle === 'string';
    }, 'sample.ts editor tab to open');

    await editorView.openEditor(openedTitle);
    const editor = new TextEditor();
    await editor.setCursor(1, 1);

    const driver = VSBrowser.instance.driver;
    const threadGlyph = await driver.wait(
      until.elementLocated(
        By.xpath(
          "//div[contains(@class,'margin-view-overlays')]//*[contains(@class,'comment-thread-unresolved')]"
        )
      ),
      15000
    );
    await driver.executeScript(
      "arguments[0].scrollIntoView({block: 'center', inline: 'nearest'})",
      threadGlyph
    );
    await threadGlyph.click();

    const resolveButton = await driver.wait(
      until.elementLocated(
        By.xpath(
          "//*[self::button or @role='button' or contains(@class,'monaco-button')][normalize-space()='Resolve' or contains(@aria-label,'Resolve') or contains(@title,'Resolve')]"
        )
      ),
      20000
    );
    await resolveButton.click();

    await waitFor(() => {
      const store = loadStore(workspacePath);
      const updated = store.comments.find((entry) => entry.id === seededCommentId);
      return updated && updated.workflowState === 'resolved';
    }, 'comment workflowState transition to resolved');
  });
});
