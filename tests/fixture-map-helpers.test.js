'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseFixtureMappings } = require('../src/modules/fixture-map-helpers');
const { createTempDir, writeFile } = require('./_test-helpers');

test('parseFixtureMappings parses fixture to class mapping', () => {
  const dir = createTempDir();
  const typesPath = writeFile(
    dir,
    'src/fixtures/types.ts',
    'type X = {\n  appPage: Pages.AppPage;\n  altPage: Pages.AltPage;\n};\n'
  );

  const mappings = parseFixtureMappings({ typesPath });

  assert.deepEqual(Array.from(mappings.fixtureKeyToClass.entries()).sort(), [
    ['altPage', 'AltPage'],
    ['appPage', 'AppPage'],
  ]);
});

test('parseFixtureMappings supports many fixture keys per class', () => {
  const dir = createTempDir();
  const typesPath = writeFile(
    dir,
    'src/fixtures/types.ts',
    'type X = {\n  pageA: Pages.SharedPage;\n  pageB: Pages.SharedPage;\n};\n'
  );

  const mappings = parseFixtureMappings({ typesPath });

  assert.deepEqual(Array.from(mappings.classToFixtureKeys.get('SharedPage') || []).sort(), ['pageA', 'pageB']);
});

test('parseFixtureMappings supports direct helper type mapping', () => {
  const dir = createTempDir();
  const typesPath = writeFile(
    dir,
    'src/fixtures/types.ts',
    'type X = {\n  userManagementHelper: UserManagementHelper;\n  rosterHelper: RosterHelper;\n};\n'
  );

  const mappings = parseFixtureMappings({ typesPath });

  assert.deepEqual(Array.from(mappings.fixtureKeyToClass.entries()).sort(), [
    ['rosterHelper', 'RosterHelper'],
    ['userManagementHelper', 'UserManagementHelper'],
  ]);
});

test('parseFixtureMappings supports multi-namespace type mapping', () => {
  const dir = createTempDir();
  const typesPath = writeFile(
    dir,
    'src/fixtures/types.ts',
    'type X = {\n  graphClient: Api.Services.GraphClient;\n};\n'
  );

  const mappings = parseFixtureMappings({ typesPath });
  assert.equal(mappings.fixtureKeyToClass.get('graphClient'), 'GraphClient');
});

test('parseFixtureMappings supports interface inheritance and type intersections', () => {
  const dir = createTempDir();
  const typesPath = writeFile(
    dir,
    'src/fixtures/types.ts',
    [
      'interface BaseFixtures {',
      '  userManagementHelper: UserManagementHelper;',
      '}',
      'type ServiceHelpersFixture = BaseFixtures & {',
      '  rosterHelper: RosterHelper;',
      '};',
      '',
    ].join('\n')
  );

  const mappings = parseFixtureMappings({ typesPath });

  assert.equal(mappings.fixtureKeyToClass.get('userManagementHelper'), 'UserManagementHelper');
  assert.equal(mappings.fixtureKeyToClass.get('rosterHelper'), 'RosterHelper');
});

test('parseFixtureMappings ignores non-class-like property types', () => {
  const dir = createTempDir();
  const typesPath = writeFile(
    dir,
    'src/fixtures/types.ts',
    [
      'type Misc = {',
      '  retries: number;',
      '  labels: string[];',
      '  status: "ok" | "fail";',
      '  page: Pages.AppPage;',
      '};',
      '',
    ].join('\n')
  );

  const mappings = parseFixtureMappings({ typesPath });
  assert.equal(mappings.fixtureKeyToClass.get('page'), 'AppPage');
  assert.equal(mappings.fixtureKeyToClass.has('retries'), false);
  assert.equal(mappings.fixtureKeyToClass.has('labels'), false);
  assert.equal(mappings.fixtureKeyToClass.has('status'), false);
});

test('parseFixtureMappings returns empty maps for missing file', () => {
  const dir = createTempDir();
  const typesPath = path.join(dir, 'missing.ts');
  const mappings = parseFixtureMappings({ typesPath });

  assert.equal(mappings.classToFixtureKeys.size, 0);
  assert.equal(mappings.fixtureKeyToClass.size, 0);
});
