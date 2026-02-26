'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildInheritanceGraph, collectImpactedClasses, getFixtureKeysForClasses } = require('../src/modules/class-impact-helpers');
const { createTempDir, writeFile } = require('./_test-helpers');

test('buildInheritanceGraph detects direct inheritance', () => {
  const dir = createTempDir();
  const basePath = writeFile(dir, 'Base.ts', 'export class Base {}');
  const childPath = writeFile(dir, 'Child.ts', 'export class Child extends Base {}');

  const graph = buildInheritanceGraph([basePath, childPath], fs.readFileSync);

  assert.equal(graph.parentsByChild.get('Child'), 'Base');
  assert.deepEqual(Array.from(graph.childrenByParent.get('Base') || []), ['Child']);
});

test('buildInheritanceGraph tracks multi-level inheritance', () => {
  const dir = createTempDir();
  const p1 = writeFile(dir, 'A.ts', 'export class A {}');
  const p2 = writeFile(dir, 'B.ts', 'export class B extends A {}');
  const p3 = writeFile(dir, 'C.ts', 'export class C extends B {}');

  const graph = buildInheritanceGraph([p1, p2, p3], fs.readFileSync);

  assert.equal(graph.parentsByChild.get('B'), 'A');
  assert.equal(graph.parentsByChild.get('C'), 'B');
});

test('collectImpactedClasses includes base and head class names', () => {
  const changedPomEntries = [{ status: 'M', effectivePath: 'src/pages/A.ts', oldPath: 'src/pages/A.ts', newPath: 'src/pages/A.ts' }];
  const childrenByParent = new Map();
  const readChangeContents = () => ({
    baseContent: 'export class OldA {}',
    headContent: 'export class NewA {}',
  });

  const impacted = collectImpactedClasses({ changedPomEntries, childrenByParent, baseRef: null, readChangeContents });

  assert.equal(impacted.has('OldA'), true);
  assert.equal(impacted.has('NewA'), true);
});

test('collectImpactedClasses includes descendants from graph', () => {
  const changedPomEntries = [{ status: 'M', effectivePath: 'src/pages/A.ts', oldPath: 'src/pages/A.ts', newPath: 'src/pages/A.ts' }];
  const childrenByParent = new Map([
    ['Base', new Set(['Child'])],
    ['Child', new Set(['GrandChild'])],
  ]);
  const readChangeContents = () => ({ baseContent: 'export class Base {}', headContent: 'export class Base {}' });

  const impacted = collectImpactedClasses({ changedPomEntries, childrenByParent, baseRef: null, readChangeContents });

  assert.equal(impacted.has('Base'), true);
  assert.equal(impacted.has('Child'), true);
  assert.equal(impacted.has('GrandChild'), true);
});

test('collectImpactedClasses handles empty entries', () => {
  const impacted = collectImpactedClasses({
    changedPomEntries: [],
    childrenByParent: new Map(),
    baseRef: null,
    readChangeContents: () => ({ baseContent: '', headContent: '' }),
  });

  assert.equal(impacted.size, 0);
});

test('getFixtureKeysForClasses returns merged keys without duplicates', () => {
  const impactedClasses = new Set(['A', 'B']);
  const classToFixtureKeys = new Map([
    ['A', new Set(['aPage', 'aExtra'])],
    ['B', new Set(['bPage', 'aPage'])],
  ]);

  const keys = getFixtureKeysForClasses(impactedClasses, classToFixtureKeys);

  assert.deepEqual(Array.from(keys).sort(), ['aExtra', 'aPage', 'bPage']);
});

test('getFixtureKeysForClasses ignores classes without mapping', () => {
  const impactedClasses = new Set(['A', 'Unknown']);
  const classToFixtureKeys = new Map([['A', new Set(['aPage'])]]);

  const keys = getFixtureKeysForClasses(impactedClasses, classToFixtureKeys);

  assert.deepEqual(Array.from(keys), ['aPage']);
});

test('buildInheritanceGraph ignores files without extends', () => {
  const dir = createTempDir();
  const a = writeFile(dir, 'Plain.ts', 'export class Plain {}');
  const graph = buildInheritanceGraph([a], fs.readFileSync);

  assert.equal(graph.parentsByChild.size, 0);
  assert.equal(graph.childrenByParent.size, 0);
});
