'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateGlobalWatch, __testOnly } = require('../src/modules/global-watch-helpers');
const { createTempDir, writeFile } = require('./_test-helpers');
const { listFilesRecursive } = require('../src/modules/file-and-git-helpers');

test('global watch glob matching works for changed entry path', () => {
  const dir = createTempDir();
  writeFile(dir, 'src/fixtures/types.ts', 'type T = {};\n');

  const result = evaluateGlobalWatch({
    repoRoot: dir,
    changedEntries: [{ status: 'M', effectivePath: 'src/fixtures/types.ts', oldPath: 'src/fixtures/types.ts', newPath: 'src/fixtures/types.ts' }],
    patterns: ['src/fixtures/**'],
    listFilesRecursive,
  });

  assert.equal(result.matchedPaths.includes('src/fixtures/types.ts'), true);
});

test('global watch reads tsconfig JSONC aliases and resolves closure transitively', () => {
  const dir = createTempDir();
  writeFile(
    dir,
    'tsconfig.json',
    [
      '{',
      '  "compilerOptions": {',
      '    "baseUrl": "./",',
      '    "paths": {',
      '      "@lib/*": ["./src/lib/*"],',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n')
  );
  writeFile(dir, 'src/watch.ts', 'import { a } from "@lib/a"; export const w = a;\n');
  writeFile(dir, 'src/lib/a.ts', 'export { b } from "./b"; export const a = 1;\n');
  writeFile(dir, 'src/lib/b.ts', 'export const b = 2;\n');

  const closure = __testOnly.resolveGlobalWatchClosure({
    repoRoot: dir,
    patterns: ['src/watch.ts'],
    listFilesRecursive,
  });

  assert.equal(closure.resolvedFilesRelative.includes('src/watch.ts'), true);
  assert.equal(closure.resolvedFilesRelative.includes('src/lib/a.ts'), true);
  assert.equal(closure.resolvedFilesRelative.includes('src/lib/b.ts'), true);
});

test('global watch resolves asset string dependency with parent fallback', () => {
  const dir = createTempDir();
  writeFile(
    dir,
    'src/api/mocks/helpers/setup.ts',
    'export const x = async (m) => m.mockOperations("k", "data.json");\n'
  );
  writeFile(dir, 'src/api/mocks/data.json', '{"ok":true}\n');

  const closure = __testOnly.resolveGlobalWatchClosure({
    repoRoot: dir,
    patterns: ['src/api/mocks/helpers/setup.ts'],
    listFilesRecursive,
  });

  assert.equal(closure.resolvedFilesRelative.includes('src/api/mocks/data.json'), true);
});

test('global watch matches changed rename entries by old/new/effective path', () => {
  const dir = createTempDir();
  writeFile(dir, 'src/global-setup-stem.ts', 'export default async () => {};\n');

  const result = evaluateGlobalWatch({
    repoRoot: dir,
    changedEntries: [
      {
        status: 'R',
        effectivePath: 'src/global-setup-stem-renamed.ts',
        oldPath: 'src/global-setup-stem.ts',
        newPath: 'src/global-setup-stem-renamed.ts',
      },
    ],
    patterns: ['src/global-setup-stem.ts'],
    listFilesRecursive,
  });

  assert.equal(result.matchedPaths.includes('src/global-setup-stem.ts'), true);
});
