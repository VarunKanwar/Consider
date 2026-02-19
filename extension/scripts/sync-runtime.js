const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFiles(sourceDir, destinationDir, files) {
  ensureDir(destinationDir);
  for (const file of files) {
    const sourcePath = path.join(sourceDir, file);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing runtime source file: ${sourcePath}`);
    }
    fs.copyFileSync(sourcePath, path.join(destinationDir, file));
  }
}

function main() {
  const extensionRoot = path.resolve(__dirname, '..');
  const repositoryRoot = path.resolve(extensionRoot, '..');

  copyFiles(
    path.join(repositoryRoot, 'cli'),
    path.join(extensionRoot, 'runtime', 'cli'),
    ['feedback-cli', 'feedback-cli.js']
  );
  copyFiles(
    path.join(repositoryRoot, 'shared'),
    path.join(extensionRoot, 'runtime', 'shared'),
    ['store.js', 'reconcile.js']
  );
}

main();
