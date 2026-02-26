'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterSpecsByImpactedMethods } = require('../src/modules/method-filter-helpers');
const { createTempDir, writeFile } = require('./_test-helpers');

test('filterSpecsByImpactedMethods returns empty result for empty input', () => {
  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map(),
    fixtureKeys: new Set(),
    impactedMethodsByClass: new Map(),
  });

  assert.equal(result.filteredSpecs.length, 0);
  assert.equal(result.droppedByMethodFilter, 0);
});

test('filter keeps all specs when impacted methods are empty', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async ({ page }) => { await page.open(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map(),
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'retained-no-impacted-methods');
});

test('filter always keeps direct changed specs', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async ({ page }) => { await page.unrelated(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [spec],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'direct-changed-spec');
});

test('filter always keeps import-graph matched specs', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async ({ page }) => { await page.unrelated(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    alwaysIncludeSpecsAbs: [spec],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'matched-import-graph');
});

test('filter drops non-matching specs by impacted method', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async ({ page }) => { await page.unrelated(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
  });

  assert.equal(result.filteredSpecs.length, 0);
  assert.equal(result.droppedByMethodFilter, 1);
});

test('filter keeps spec when direct fixture method call matches', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async ({ page }) => { await page.open(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'matched-precise');
});

test('filter keeps spec for literal element access call page["open"]()', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async ({ page }) => { await page["open"](); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'matched-precise');
});

test('filter keeps spec for dynamic element access in fail-open mode', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async ({ page }) => { const key = "open"; await page[key](); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
    selectionBias: 'fail-open',
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'matched-uncertain-fail-open');
  assert.equal(result.uncertainCallSites, 1);
});

test('filter drops dynamic element access in fail-closed mode', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async ({ page }) => { const key = "open"; await page[key](); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
    selectionBias: 'fail-closed',
  });

  assert.equal(result.filteredSpecs.length, 0);
  assert.equal(result.uncertainCallSites, 1);
});

test('filter matches optional chain page?.open?.() as precise', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async ({ page }) => { await page?.open?.(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'matched-precise');
});

test('CallChain node is processed without crash', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async ({ page }) => { await page?.open(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
});

test('this.a.b.m() deep chain within depth limit is handled as precise', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test(\"x\", async ({ page }) => { await page.a.b.open(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
    selectionBias: 'fail-open',
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'matched-precise');
});

test('Deep chain beyond depth limit is marked uncertain', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test(\"x\", async ({ page }) => { await page.a.b.c.open(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
    selectionBias: 'fail-open',
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'matched-uncertain-fail-open');
});

test('filter does not produce false precise match for optional chain with another method', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async ({ page }) => { await page?.close?.(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
  });

  assert.equal(result.filteredSpecs.length, 0);
});

test('optional element access marks uncertain in fail-open mode', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test(\"x\", async ({ page }) => { const k = \"open\"; await page?.[k]?.(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
    selectionBias: 'fail-open',
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'matched-uncertain-fail-open');
});

test('Alias pattern const fn = page.open; fn() is marked uncertain', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test(\"x\", async ({ page }) => { const fn = page.open; await fn(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
    selectionBias: 'fail-open',
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'matched-uncertain-fail-open');
});

test('Destructuring alias const { open } = page; open() is marked uncertain', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test(\"x\", async ({ page }) => { const { open } = page; await open(); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
    selectionBias: 'fail-open',
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'matched-uncertain-fail-open');
});

test('filter keeps spec without fixture bindings in callback params', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async () => { expect(1).toBe(1); });');

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'retained-no-bindings');
});

test('filter keeps spec on read error', () => {
  const dir = createTempDir();
  const spec = writeFile(dir, 'a.spec.ts', 'test("x", async ({ page }) => { await page.open(); });');
  const fs = require('fs');
  fs.unlinkSync(spec);

  const result = filterSpecsByImpactedMethods({
    selectedSpecs: [spec],
    directChangedSpecsAbs: [],
    fixtureKeyToClass: new Map([['page', 'Page']]),
    fixtureKeys: new Set(['page']),
    impactedMethodsByClass: new Map([['Page', new Set(['open'])]]),
  });

  assert.deepEqual(result.filteredSpecs, [spec]);
  assert.equal(result.selectionReasons.get(spec), 'retained-read-error');
});
