const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

function createIsolatedWorkspace(fixturePath) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-loop-host-'));
  const workspacePath = path.join(tmpRoot, 'workspace');
  fs.cpSync(fixturePath, workspacePath, { recursive: true });
  return { tmpRoot, workspacePath };
}

async function main() {
  let tmpRoot;
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '..');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const fixtureWorkspacePath = path.resolve(__dirname, './fixtures/workspace');
    const isolated = createIsolatedWorkspace(fixtureWorkspacePath);
    tmpRoot = isolated.tmpRoot;
    const workspacePath = isolated.workspacePath;
    const userDataDir = path.join(tmpRoot, 'user-data');
    const extensionsDir = path.join(tmpRoot, 'extensions');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(extensionsDir, { recursive: true });

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        '--disable-extensions',
        '--disable-workspace-trust',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
      ],
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to run extension host tests');
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  } finally {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
}

main();
