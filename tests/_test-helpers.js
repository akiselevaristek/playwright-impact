'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'test-impact-core-'));

const ensureDirForFile = (filePath) => fs.mkdirSync(path.dirname(filePath), { recursive: true });

const writeFile = (rootDir, relativePath, content) => {
  const filePath = path.join(rootDir, relativePath);
  ensureDirForFile(filePath);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
};

const run = (cwd, command, args) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed: ${details}`);
  }
  return result;
};

const initGitRepo = (cwd) => {
  run(cwd, 'git', ['init', '-q']);
  run(cwd, 'git', ['config', 'user.email', 'test@example.com']);
  run(cwd, 'git', ['config', 'user.name', 'Test User']);
};

const commitAll = (cwd, message) => {
  run(cwd, 'git', ['add', '.']);
  run(cwd, 'git', ['commit', '-q', '-m', message]);
};

module.exports = {
  createTempDir,
  writeFile,
  initGitRepo,
  commitAll,
  run,
};
