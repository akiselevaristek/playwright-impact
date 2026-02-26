'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectChangedMethodsByClass, buildImpactedMethodsByClass } = require('../src/modules/method-impact-helpers');
const { createTempDir, writeFile } = require('./_test-helpers');

const changedEntry = { status: 'M', effectivePath: 'src/pages/A.ts', oldPath: 'src/pages/A.ts', newPath: 'src/pages/A.ts' };

const mapToObject = (map) => {
  const result = {};
  for (const [k, v] of map.entries()) result[k] = Array.from(v).sort();
  return result;
};

test('collectChangedMethodsByClass detects changed method body', () => {
  const result = collectChangedMethodsByClass({
    changedPomEntries: [changedEntry],
    baseRef: 'HEAD',
    readChangeContents: () => ({
      basePath: 'src/pages/A.ts',
      headPath: 'src/pages/A.ts',
      baseContent: 'export class A { run(){ return 1; } }',
      headContent: 'export class A { run(){ return 2; } }',
    }),
  });

  assert.equal(result.changedMethodsByClass.get('A').has('run'), true);
  assert.equal(result.stats.semanticChangedMethodsCount >= 1, true);
});

test('collectChangedMethodsByClass ignores formatting-only changes', () => {
  const result = collectChangedMethodsByClass({
    changedPomEntries: [changedEntry],
    baseRef: 'HEAD',
    readChangeContents: () => ({
      basePath: 'src/pages/A.ts',
      headPath: 'src/pages/A.ts',
      baseContent: 'export class A { run(){ return 1; } }',
      headContent: 'export   class   A{\nrun(){\nreturn 1;\n}\n}',
    }),
  });

  assert.equal(result.stats.semanticChangedMethodsCount, 0);
});

test('collectChangedMethodsByClass marks callable members when field changes', () => {
  const result = collectChangedMethodsByClass({
    changedPomEntries: [changedEntry],
    baseRef: 'HEAD',
    readChangeContents: () => ({
      basePath: 'src/pages/A.ts',
      headPath: 'src/pages/A.ts',
      baseContent: 'export class A { private a: string; one(){return 1;} two(){return 2;} }',
      headContent: 'export class A { private a: number; one(){return 1;} two(){return 2;} }',
    }),
  });

  const methods = Array.from(result.changedMethodsByClass.get('A') || []);
  assert.equal(methods.includes('one'), true);
  assert.equal(methods.includes('two'), true);
});

test('collectChangedMethodsByClass marks all callables on top-level runtime change', () => {
  const result = collectChangedMethodsByClass({
    changedPomEntries: [changedEntry],
    baseRef: 'HEAD',
    readChangeContents: () => ({
      basePath: 'src/pages/A.ts',
      headPath: 'src/pages/A.ts',
      baseContent: 'const FLAG = 1; export class A { one(){return 1;} two(){return 2;} }',
      headContent: 'const FLAG = 2; export class A { one(){return 1;} two(){return 2;} }',
    }),
  });

  assert.equal(result.stats.topLevelRuntimeChangedFiles, 1);
  const methods = Array.from(result.changedMethodsByClass.get('A') || []);
  assert.equal(methods.includes('one'), true);
  assert.equal(methods.includes('two'), true);
});

test('collectChangedMethodsByClass handles class rename between base and head', () => {
  const result = collectChangedMethodsByClass({
    changedPomEntries: [changedEntry],
    baseRef: 'HEAD',
    readChangeContents: () => ({
      basePath: 'src/pages/A.ts',
      headPath: 'src/pages/B.ts',
      baseContent: 'export class OldA { run(){ return 1; } }',
      headContent: 'export class NewA { run(){ return 2; } }',
    }),
  });

  const obj = mapToObject(result.changedMethodsByClass);
  assert.equal(Object.keys(obj).length > 0, true);
});

test('buildImpactedMethodsByClass propagates through this-call chain', () => {
  const dir = createTempDir();
  const file = writeFile(dir, 'A.ts', 'export class A { leaf(){return 1;} mid(){ return this.leaf(); } top(){ return this.mid(); } }');

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['A']),
    changedMethodsByClass: new Map([['A', new Set(['leaf'])]]),
    parentsByChild: new Map(),
    pageFiles: [file],
  });

  const methods = Array.from(result.impactedMethodsByClass.get('A') || []);
  assert.equal(methods.includes('leaf'), true);
  assert.equal(methods.includes('mid'), true);
  assert.equal(methods.includes('top'), true);
});

test('buildImpactedMethodsByClass supports this["method"] call', () => {
  const dir = createTempDir();
  const file = writeFile(dir, 'A.ts', 'export class A { leaf(){return 1;} call(){ return this["leaf"](); } }');

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['A']),
    changedMethodsByClass: new Map([['A', new Set(['leaf'])]]),
    parentsByChild: new Map(),
    pageFiles: [file],
  });

  const methods = Array.from(result.impactedMethodsByClass.get('A') || []);
  assert.equal(methods.includes('call'), true);
});

test('buildImpactedMethodsByClass supports this[key] as fail-open by including class call sites', () => {
  const dir = createTempDir();
  const file = writeFile(
    dir,
    'A.ts',
    'export class A { leaf(){return 1;} safe(){return 2;} dyn(){ const key = "leaf"; return this[key](); } caller(){ return this.dyn(); } }'
  );

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['A']),
    changedMethodsByClass: new Map([['A', new Set(['leaf'])]]),
    parentsByChild: new Map(),
    pageFiles: [file],
  });

  const methods = Array.from(result.impactedMethodsByClass.get('A') || []);
  assert.equal(methods.includes('dyn'), true);
  assert.equal(methods.includes('caller'), true);
});

test('buildImpactedMethodsByClass propagates through super calls', () => {
  const dir = createTempDir();
  const base = writeFile(dir, 'Base.ts', 'export class Base { changed(){ return 1; } }');
  const child = writeFile(dir, 'Child.ts', 'export class Child extends Base { use(){ return super.changed(); } }');

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['Base']),
    changedMethodsByClass: new Map([['Base', new Set(['changed'])]]),
    parentsByChild: new Map([['Child', 'Base']]),
    pageFiles: [base, child],
  });

  const childMethods = Array.from(result.impactedMethodsByClass.get('Child') || []);
  assert.equal(childMethods.includes('use'), true);
});

test('buildImpactedMethodsByClass projects composition owner classes', () => {
  const dir = createTempDir();
  const widget = writeFile(dir, 'Widget.ts', 'export class Widget { click(){ return 1; } }');
  const page = writeFile(dir, 'Page.ts', 'export class Page { widget: Widget; open(){ return this.widget.click(); } }');

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['Widget']),
    changedMethodsByClass: new Map([['Widget', new Set(['click'])]]),
    parentsByChild: new Map(),
    pageFiles: [widget, page],
  });

  const pageMethods = Array.from(result.impactedMethodsByClass.get('Page') || []);
  assert.equal(pageMethods.includes('open'), true);
});

test('buildImpactedMethodsByClass handles empty changed methods map', () => {
  const dir = createTempDir();
  const file = writeFile(dir, 'A.ts', 'export class A { run(){ return 1; } }');

  const result = buildImpactedMethodsByClass({
    impactedClasses: new Set(['A']),
    changedMethodsByClass: new Map(),
    parentsByChild: new Map(),
    pageFiles: [file],
  });

  assert.equal(result.impactedMethodsByClass.size, 0);
  assert.equal(result.stats.impactedMethodsTotal, 0);
});
