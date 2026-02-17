const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '..');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const workspacePath = path.resolve(__dirname, './fixtures/workspace');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspacePath, '--disable-extensions'],
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to run extension host tests');
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  }
}

main();

