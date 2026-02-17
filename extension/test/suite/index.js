const fs = require('fs');
const path = require('path');
const Mocha = require('mocha');

function collectTestFiles(dirPath, output) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(fullPath, output);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      output.push(fullPath);
    }
  }
}

async function run() {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 30000,
  });

  const suiteRoot = path.resolve(__dirname);
  const files = [];
  collectTestFiles(suiteRoot, files);
  files.sort();

  for (const file of files) {
    mocha.addFile(file);
  }

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} extension host test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}

module.exports = {
  run,
};

