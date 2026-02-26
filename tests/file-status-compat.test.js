'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __testOnly } = require('../src/modules/file-and-git-helpers');

const { parseChangedEntryLine, normalizeEntryStatus, mergeByPriority } = __testOnly;

test('Copy status (C) treated safely as add with warning', () => {
  const parsed = parseChangedEntryLine('C100\tsrc/a.ts\tsrc/b.ts');
  const warnings = [];
  const normalized = normalizeEntryStatus(parsed, warnings);

  assert.equal(normalized.status, 'A');
  assert.equal(warnings.length > 0, true);
});

test('Type change status (T) treated safely as modify with warning', () => {
  const parsed = parseChangedEntryLine('T\tsrc/a.ts');
  const warnings = [];
  const normalized = normalizeEntryStatus(parsed, warnings);

  assert.equal(normalized.status, 'M');
  assert.equal(warnings.length > 0, true);
});

test('Unmerged status (U) treated safely as modify with warning', () => {
  const parsed = parseChangedEntryLine('U\tsrc/a.ts');
  const warnings = [];
  const normalized = normalizeEntryStatus(parsed, warnings);

  assert.equal(normalized.status, 'M');
  assert.equal(warnings.length > 0, true);
});

test('Unknown git status triggers compat fallback with warning', () => {
  const parsed = parseChangedEntryLine('Z\tsrc/a.ts');
  const warnings = [];
  const normalized = normalizeEntryStatus(parsed, warnings);

  assert.equal(normalized.status, 'M');
  assert.equal(warnings.length > 0, true);
});

test('Status merge precedence D > R > M > A is deterministic', () => {
  const a = { status: 'A', effectivePath: 'x.ts' };
  const m = { status: 'M', effectivePath: 'x.ts' };
  const r = { status: 'R', effectivePath: 'x.ts', oldPath: 'old.ts', newPath: 'x.ts' };
  const d = { status: 'D', effectivePath: 'x.ts' };

  assert.equal(mergeByPriority(a, m).status, 'M');
  assert.equal(mergeByPriority(m, r).status, 'R');
  assert.equal(mergeByPriority(r, d).status, 'D');
  assert.equal(mergeByPriority(d, a).status, 'D');
});
