const fs = require('fs');
const os = require('os');
const path = require('path');
const vsce = require('@vscode/vsce');
const { ExTester } = require('vscode-extension-tester');

function resetDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function main() {
  const fixtureWorkspace = path.resolve(__dirname, 'fixtures', 'workspace');
  const persistedArtifactsRoot = path.resolve(__dirname, '.artifacts');
  const cacheRoot =
    process.env.FEEDBACK_LOOP_UI_CACHE_DIR || path.resolve(__dirname, '.cache');
  const runId = `run-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const runRoot = path.join(os.tmpdir(), 'feedback-loop-ui-smoke', runId);
  const workspacePath = path.join(runRoot, 'workspace');
  const storagePath = path.join(cacheRoot, 'extester');
  const extensionsPath = path.join(cacheRoot, 'extensions');
  const extensionRoot = path.resolve(__dirname, '..');
  const vsixPath = path.join(runRoot, 'feedback-loop-ui-smoke.vsix');
  const testsGlob = path.resolve(__dirname, 'suite', '*.test.js');
  const settingsPath = path.resolve(__dirname, 'settings.json');
  const vscodeVersion = process.env.FEEDBACK_LOOP_UI_CODE_VERSION || '1.109.4';
  const offline = process.env.FEEDBACK_LOOP_UI_SMOKE_OFFLINE === '1';

  resetDir(runRoot);
  ensureDir(cacheRoot);
  ensureDir(storagePath);
  ensureDir(extensionsPath);
  fs.cpSync(fixtureWorkspace, workspacePath, { recursive: true });

  process.env.FEEDBACK_LOOP_UI_WORKSPACE = workspacePath;
  process.env.FEEDBACK_LOOP_UI_ARTIFACTS = runRoot;
  process.env.FEEDBACK_LOOP_UI_REPO_ROOT = path.resolve(extensionRoot, '..');

  const exTester = new ExTester(storagePath, undefined, extensionsPath);
  const originalCwd = process.cwd();
  let exitCode = 1;
  try {
    process.chdir(extensionRoot);

    if (!offline) {
      await exTester.downloadCode(vscodeVersion);
      await exTester.downloadChromeDriver(vscodeVersion);
    }

    // Package non-interactively so CI never blocks on vsce prompts.
    await vsce.createVSIX({
      cwd: extensionRoot,
      packagePath: vsixPath,
      useYarn: false,
      allowMissingRepository: true,
      allowPackageAllSecrets: true,
      allowPackageEnvFile: true,
      skipLicense: true,
    });

    await exTester.installVsix({
      vsixFile: vsixPath,
      installDependencies: false,
    });

    exitCode = await exTester.runTests([testsGlob], {
      vscodeVersion,
      settings: settingsPath,
      cleanup: true,
      offline,
      resources: [workspacePath],
    });
  } finally {
    process.chdir(originalCwd);
  }

  if (exitCode === 0) {
    fs.rmSync(runRoot, { recursive: true, force: true });
    process.exit(0);
  }

  ensureDir(persistedArtifactsRoot);
  const persistedRunPath = path.join(persistedArtifactsRoot, runId);
  resetDir(persistedRunPath);
  fs.cpSync(runRoot, persistedRunPath, { recursive: true });
  fs.rmSync(runRoot, { recursive: true, force: true });

  // eslint-disable-next-line no-console
  console.error(`UI smoke artifacts kept at: ${persistedRunPath}`);
  process.exit(exitCode);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to run UI smoke tests.');
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
