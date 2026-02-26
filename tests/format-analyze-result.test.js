'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatSelectionReasonsForLog } = require('../src/format-analyze-result');

test('formatSelectionReasonsForLog returns empty string for empty input', () => {
  const result = formatSelectionReasonsForLog({ selectedSpecs: [], selectionReasons: new Map(), repoRoot: process.cwd() });
  assert.equal(result, '');
});

test('formatSelectionReasonsForLog truncates output by maxLines', () => {
  const repoRoot = '/repo';
  const selectedSpecs = ['/repo/tests/a.spec.ts', '/repo/tests/b.spec.ts', '/repo/tests/c.spec.ts'];
  const selectionReasons = new Map([
    ['/repo/tests/a.spec.ts', 'reason A'],
    ['/repo/tests/b.spec.ts', 'reason B'],
    ['/repo/tests/c.spec.ts', 'reason C'],
  ]);

  const result = formatSelectionReasonsForLog({ selectedSpecs, selectionReasons, repoRoot, maxLines: 2 });

  assert.match(result, /a\.spec\.ts: reason A/);
  assert.match(result, /b\.spec\.ts: reason B/);
  assert.match(result, /\.\.\. 1 more selected specs with reasons/);
});
