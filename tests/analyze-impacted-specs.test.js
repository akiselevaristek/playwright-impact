'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeImpactedSpecs } = require('../src/analyze-impacted-specs');

test('analyzeImpactedSpecs validates required inputs', () => {
  assert.throws(() => analyzeImpactedSpecs({}), /Missing required profile configuration/);

  assert.throws(
    () =>
      analyzeImpactedSpecs({
        repoRoot: process.cwd(),
        profile: { testsRootRelative: 'tests', changedSpecPrefix: 'tests/' },
      }),
    /Missing profile\.isRelevantPomPath/
  );
});

test('analyzeImpactedSpecs accepts new option fields without throwing', () => {
  assert.throws(
    () =>
      analyzeImpactedSpecs({
        repoRoot: '',
        profile: {
          testsRootRelative: 'tests',
          changedSpecPrefix: 'tests/',
          isRelevantPomPath: () => true,
        },
        includeWorkingTreeWithBase: true,
        fileExtensions: ['.ts', '.tsx'],
        selectionBias: 'fail-open',
      }),
    /Missing required repoRoot/
  );
});
