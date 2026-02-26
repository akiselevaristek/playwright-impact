'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectSpecFiles } = require('../src/modules/spec-selection-helpers');
const { createTempDir, writeFile } = require('./_test-helpers');

const listFilesRecursive = (rootDir) => {
  const fs = require('fs');
  const path = require('path');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(rootDir);
  return files;
};

test('selectSpecFiles selects spec by fixture key usage in async callback', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'tests/a.spec.ts', 'test("x", async ({ appPage, somethingElse }) => { await appPage.open(); });');

  const selected = selectSpecFiles({ testsRootAbs: dir, fixtureKeys: new Set(['appPage']), listFilesRecursive });

  assert.deepEqual(selected, [spec]);
});

test('selectSpecFiles selects spec by fixture key usage in sync callback', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'tests/a.spec.ts', 'test("x", ({ appPage }) => { void appPage; });');

  const selected = selectSpecFiles({ testsRootAbs: dir, fixtureKeys: new Set(['appPage']), listFilesRecursive });

  assert.deepEqual(selected, [spec]);
});

test('selectSpecFiles supports alias binding in callback params', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'tests/a.spec.ts', 'test("x", async ({ appPage: p }) => { await p.open(); });');

  const selected = selectSpecFiles({ testsRootAbs: dir, fixtureKeys: new Set(['appPage']), listFilesRecursive });

  assert.deepEqual(selected, [spec]);
});

test('selectSpecFiles supports default binding in callback params', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'tests/a.spec.ts', 'test("x", async ({ appPage = fallback }) => { await appPage.open(); });');

  const selected = selectSpecFiles({ testsRootAbs: dir, fixtureKeys: new Set(['appPage']), listFilesRecursive });

  assert.deepEqual(selected, [spec]);
});

test('selectSpecFiles supports rest pattern in callback params', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'tests/a.spec.ts', 'test(\"x\", async ({ appPage, ...rest }) => { await appPage.open(); });');

  const selected = selectSpecFiles({ testsRootAbs: dir, fixtureKeys: new Set(['appPage']), listFilesRecursive });

  assert.deepEqual(selected, [spec]);
});

test('selectSpecFiles supports nested object binding edge form', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'tests/a.spec.ts', 'test(\"x\", async ({ appPage: { open } }) => { void open; });');

  const selected = selectSpecFiles({ testsRootAbs: dir, fixtureKeys: new Set(['appPage']), listFilesRecursive });

  assert.deepEqual(selected, [spec]);
});

test('selectSpecFiles supports multiple fixtures in same callback', () => {
  const dir = createTempDir();
  const spec = writeFile(
    dir,
    'tests/a.spec.ts',
    'test("x", async ({ altPage, appPage }) => { await altPage.open(); await appPage.open(); });'
  );

  const selected = selectSpecFiles({ testsRootAbs: dir, fixtureKeys: new Set(['altPage']), listFilesRecursive });

  assert.deepEqual(selected, [spec]);
});

test('selectSpecFiles scans nested directories', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'tests/nested/case.spec.ts', 'test("x", async ({ pageA }) => { await pageA.open(); });');

  const selected = selectSpecFiles({ testsRootAbs: dir, fixtureKeys: new Set(['pageA']), listFilesRecursive });

  assert.deepEqual(selected, [spec]);
});

test('selectSpecFiles supports tsx spec files', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'tests/ui.spec.tsx', 'test("x", async ({ appPage }) => { await appPage.open(); return <div />; });');

  const selected = selectSpecFiles({ testsRootAbs: dir, fixtureKeys: new Set(['appPage']), listFilesRecursive });

  assert.deepEqual(selected, [spec]);
});

test('selectSpecFiles ignores non-impacted fixtures', () => {
  const dir = createTempDir();
  writeFile(dir, 'tests/a.spec.ts', 'test("x", async ({ abc }) => { await abc.run(); });');

  const selected = selectSpecFiles({ testsRootAbs: dir, fixtureKeys: new Set(['appPage']), listFilesRecursive });

  assert.equal(selected.length, 0);
});
