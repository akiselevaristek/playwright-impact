'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getChangedEntries } = require('../src/modules/file-and-git-helpers');
const { createTempDir, writeFile, initGitRepo, commitAll, run } = require('./_test-helpers');

const profile = {
  isRelevantPomPath: (filePath) => filePath.startsWith('src/pages/') && (filePath.endsWith('.ts') || filePath.endsWith('.tsx')),
};

const setupRepo = () => {
  const dir = createTempDir();
  initGitRepo(dir);
  writeFile(dir, 'src/pages/Page.ts', 'export class Page { open(){ return 1; } }\n');
  writeFile(dir, 'README.md', '# test\n');
  commitAll(dir, 'base');
  return dir;
};

test('getChangedEntries includes unstaged working tree changes when baseRef is provided', () => {
  const dir = setupRepo();
  writeFile(dir, 'README.md', '# test2\n');
  commitAll(dir, 'commit2');

  writeFile(dir, 'src/pages/Page.ts', 'export class Page { open(){ return 2; } }\n');

  const noWorkingTree = getChangedEntries({
    repoRoot: dir,
    baseRef: 'HEAD~1',
    includeWorkingTreeWithBase: false,
    profile,
    fileExtensions: ['.ts', '.tsx'],
  });
  const withWorkingTree = getChangedEntries({
    repoRoot: dir,
    baseRef: 'HEAD~1',
    includeWorkingTreeWithBase: true,
    profile,
    fileExtensions: ['.ts', '.tsx'],
  });

  assert.equal(noWorkingTree.entries.some((entry) => entry.effectivePath === 'src/pages/Page.ts'), false);
  assert.equal(withWorkingTree.entries.some((entry) => entry.effectivePath === 'src/pages/Page.ts'), true);
});

test('getChangedEntries includes staged working tree changes when baseRef is provided', () => {
  const dir = setupRepo();
  writeFile(dir, 'README.md', '# test2\n');
  commitAll(dir, 'commit2');

  writeFile(dir, 'src/pages/Page.ts', 'export class Page { open(){ return 3; } }\n');
  run(dir, 'git', ['add', 'src/pages/Page.ts']);

  const result = getChangedEntries({ repoRoot: dir, baseRef: 'HEAD~1', includeWorkingTreeWithBase: true, profile, fileExtensions: ['.ts', '.tsx'] });
  assert.equal(result.entries.some((entry) => entry.effectivePath === 'src/pages/Page.ts'), true);
});

test('includeWorkingTreeWithBase disabled ignores working tree changes', () => {
  const dir = setupRepo();
  writeFile(dir, 'README.md', '# test2\n');
  commitAll(dir, 'commit2');

  writeFile(dir, 'src/pages/Page.ts', 'export class Page { open(){ return 10; } }\n');

  const result = getChangedEntries({
    repoRoot: dir,
    baseRef: 'HEAD~1',
    includeWorkingTreeWithBase: false,
    profile,
    fileExtensions: ['.ts', '.tsx'],
  });

  assert.equal(result.entries.some((entry) => entry.effectivePath === 'src/pages/Page.ts'), false);
  assert.equal(result.changedEntriesBySource.fromWorkingTree, 0);
});

test('getChangedEntries includes untracked ts source entries', () => {
  const dir = setupRepo();
  writeFile(dir, 'src/pages/NewPage.ts', 'export class NewPage {}\n');

  const result = getChangedEntries({ repoRoot: dir, baseRef: null, includeWorkingTreeWithBase: true, profile, fileExtensions: ['.ts', '.tsx'] });
  assert.equal(result.entries.some((entry) => entry.effectivePath === 'src/pages/NewPage.ts' && entry.status === 'A'), true);
  assert.equal(result.changedEntriesBySource.fromUntracked >= 1, true);
});

test('getChangedEntries includes untracked tsx source entries', () => {
  const dir = setupRepo();
  writeFile(dir, 'src/pages/NewPage.tsx', 'export class NewPage {}\n');

  const result = getChangedEntries({ repoRoot: dir, baseRef: null, includeWorkingTreeWithBase: true, profile, fileExtensions: ['.ts', '.tsx'] });
  assert.equal(result.entries.some((entry) => entry.effectivePath === 'src/pages/NewPage.tsx' && entry.status === 'A'), true);
});

test('getChangedEntries detects rename status with -M', () => {
  const dir = setupRepo();
  run(dir, 'git', ['mv', 'src/pages/Page.ts', 'src/pages/PageRenamed.ts']);

  const result = getChangedEntries({ repoRoot: dir, baseRef: null, includeWorkingTreeWithBase: true, profile, fileExtensions: ['.ts', '.tsx'] });
  const renameEntry = result.entries.find((entry) => entry.effectivePath === 'src/pages/PageRenamed.ts');

  assert.ok(renameEntry);
  assert.equal(renameEntry.status, 'R');
  assert.equal(renameEntry.oldPath, 'src/pages/Page.ts');
  assert.equal(renameEntry.newPath, 'src/pages/PageRenamed.ts');
});

test('getChangedEntries keeps higher-priority status when path appears in both diff sources', () => {
  const dir = setupRepo();
  run(dir, 'git', ['mv', 'src/pages/Page.ts', 'src/pages/PageRenamed.ts']);
  commitAll(dir, 'rename page');

  writeFile(dir, 'src/pages/PageRenamed.ts', 'export class Page { open(){ return 4; } }\n');

  const result = getChangedEntries({ repoRoot: dir, baseRef: 'HEAD~1', includeWorkingTreeWithBase: true, profile, fileExtensions: ['.ts', '.tsx'] });
  const entry = result.entries.find((item) => item.effectivePath === 'src/pages/PageRenamed.ts');

  assert.ok(entry);
  assert.equal(entry.status, 'R');
});

test('Combined base...HEAD and working tree diffs are unioned', () => {
  const dir = setupRepo();
  writeFile(dir, 'src/pages/Committed.ts', 'export class Committed { open(){ return 1; } }\n');
  commitAll(dir, 'add committed page');
  writeFile(dir, 'src/pages/Working.ts', 'export class Working { open(){ return 1; } }\n');

  const result = getChangedEntries({
    repoRoot: dir,
    baseRef: 'HEAD~1',
    includeWorkingTreeWithBase: true,
    profile,
    fileExtensions: ['.ts', '.tsx'],
  });

  assert.equal(result.entries.some((entry) => entry.effectivePath === 'src/pages/Committed.ts'), true);
  assert.equal(result.entries.some((entry) => entry.effectivePath === 'src/pages/Working.ts'), true);
  assert.equal(result.changedEntriesBySource.fromBaseHead >= 1, true);
  assert.equal(result.changedEntriesBySource.fromWorkingTree + result.changedEntriesBySource.fromUntracked >= 1, true);
});
