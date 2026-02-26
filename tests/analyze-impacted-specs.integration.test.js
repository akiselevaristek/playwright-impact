'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { analyzeImpactedSpecs } = require('../src/analyze-impacted-specs');
const { createTempDir, writeFile, initGitRepo, commitAll, run } = require('./_test-helpers');

const genericProfile = {
  testsRootRelative: 'tests-app',
  changedSpecPrefix: 'tests-app/',
  analysisRootsRelative: ['src/pages', 'src/utils'],
  fixturesTypesRelative: 'src/fixtures/types.ts',
  isRelevantPomPath: (filePath) => filePath.startsWith('src/pages/') && (filePath.endsWith('.ts') || filePath.endsWith('.tsx')),
};

const profileWithApi = {
  ...genericProfile,
  analysisRootsRelative: ['src/pages', 'src/utils', 'src/api'],
  globalWatchMode: 'disabled',
  isRelevantPomPath: (filePath) =>
    (filePath.startsWith('src/pages/') || filePath.startsWith('src/api/')) &&
    (filePath.endsWith('.ts') || filePath.endsWith('.tsx')),
};

const profileWithApiAllFiles = {
  ...genericProfile,
  analysisRootsRelative: ['src/pages', 'src/utils', 'src/api'],
  globalWatchMode: 'disabled',
  isRelevantPomPath: (filePath) =>
    filePath.startsWith('src/pages/') ||
    filePath.startsWith('src/api/'),
};

const createBaseRepo = () => {
  const dir = createTempDir();
  initGitRepo(dir);

  writeFile(dir, 'src/pages/MyPage.ts', 'export class MyPage { target(){ return 1; } open(){ return this.target(); } }\n');
  writeFile(dir, 'src/fixtures/types.ts', 'type T = {\n  myPage: Pages.MyPage;\n};\n');
  writeFile(dir, 'tests-app/basic.spec.ts', 'test("x", async ({ myPage }) => { await myPage.open(); });\n');

  commitAll(dir, 'base');
  return dir;
};

test('README minimal profile style works with tests/ root and reports changed spec', () => {
  const dir = createTempDir();
  initGitRepo(dir);

  writeFile(dir, 'src/pages/LoginPage.ts', 'export class LoginPage { open(){ return 1; } }\n');
  writeFile(dir, 'src/utils/session.ts', 'export const getSession = () => "ok";\n');
  writeFile(dir, 'src/fixtures/types.ts', 'type T = { loginPage: Pages.LoginPage };\n');
  writeFile(dir, 'tests/auth/login.spec.ts', 'test("login", async ({ loginPage }) => { await loginPage.open(); });\n');
  commitAll(dir, 'base');

  const profile = {
    testsRootRelative: 'tests',
    changedSpecPrefix: 'tests/',
    isRelevantPomPath: (filePath) =>
      (filePath.startsWith('src/pages/') || filePath.startsWith('src/utils/')) &&
      (filePath.endsWith('.ts') || filePath.endsWith('.tsx')),
  };

  const cleanResult = analyzeImpactedSpecs({ repoRoot: dir, profile });
  assert.equal(cleanResult.hasAnythingToRun, false);

  writeFile(dir, 'tests/auth/login.spec.ts', 'test("login", async ({ loginPage }) => { await loginPage.open(); await loginPage.open(); });\n');

  const changedResult = analyzeImpactedSpecs({ repoRoot: dir, profile });
  assert.equal(changedResult.hasAnythingToRun, true);
  assert.equal(changedResult.selectedSpecsRelative.includes('tests/auth/login.spec.ts'), true);
});

test('analyzeImpactedSpecs returns no work when nothing changed', () => {
  const dir = createBaseRepo();
  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, includeUntrackedSpecs: true });

  assert.equal(result.hasAnythingToRun, false);
  assert.equal(result.selectedSpecs.length, 0);
});

test('analyzeImpactedSpecs includes direct changed spec', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'tests-app/basic.spec.ts', 'test("x", async ({ myPage }) => { await myPage.open(); await myPage.open(); });\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, includeUntrackedSpecs: true });

  assert.equal(result.selectedSpecsRelative.includes('tests-app/basic.spec.ts'), true);
  assert.equal(result.selectionReasons.values().next().value, 'direct-changed-spec');
});

test('analyzeImpactedSpecs includes untracked spec when enabled', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'tests-app/newly-added.spec.ts', 'test("x", async ({ myPage }) => { await myPage.open(); });\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, includeUntrackedSpecs: true });

  assert.equal(result.selectedSpecsRelative.includes('tests-app/newly-added.spec.ts'), true);
});

test('analyzeImpactedSpecs ignores untracked spec when disabled', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'tests-app/newly-added.spec.ts', 'test("x", async ({ myPage }) => { await myPage.open(); });\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, includeUntrackedSpecs: false });

  assert.equal(result.selectedSpecsRelative.includes('tests-app/newly-added.spec.ts'), false);
});

test('analyzeImpactedSpecs includes unstaged source change with baseRef when includeWorkingTreeWithBase=true', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'README.md', '# first\n');
  commitAll(dir, 'second commit');

  writeFile(dir, 'src/pages/MyPage.ts', 'export class MyPage { target(){ return 2; } open(){ return this.target(); } }\n');

  const withWorkingTree = analyzeImpactedSpecs({
    repoRoot: dir,
    baseRef: 'HEAD~1',
    profile: genericProfile,
    includeWorkingTreeWithBase: true,
  });

  const withoutWorkingTree = analyzeImpactedSpecs({
    repoRoot: dir,
    baseRef: 'HEAD~1',
    profile: genericProfile,
    includeWorkingTreeWithBase: false,
  });

  assert.equal(withWorkingTree.hasAnythingToRun, true);
  assert.equal(withoutWorkingTree.hasAnythingToRun, false);
});

test('analyzeImpactedSpecs includes staged source change with baseRef when includeWorkingTreeWithBase=true', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'README.md', '# first\n');
  commitAll(dir, 'second commit');

  writeFile(dir, 'src/pages/MyPage.ts', 'export class MyPage { target(){ return 3; } open(){ return this.target(); } }\n');
  run(dir, 'git', ['add', 'src/pages/MyPage.ts']);

  const result = analyzeImpactedSpecs({ repoRoot: dir, baseRef: 'HEAD~1', profile: genericProfile, includeWorkingTreeWithBase: true });
  assert.equal(result.hasAnythingToRun, true);
});

test('analyzeImpactedSpecs includes untracked source ts and tsx files', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'src/pages/NewPage.ts', 'export class NewPage { run(){ return 1; } }\n');
  writeFile(dir, 'src/pages/NewPage.tsx', 'export class NewPageTsx { run(){ return 1; } }\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, includeUntrackedSpecs: true });

  assert.equal(result.changedEntriesBySource.fromUntracked >= 2, true);
});

test('analyzeImpactedSpecs marks uncertain dynamic callsite and keeps spec in fail-open mode', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'tests-app/basic.spec.ts', 'test("x", async ({ myPage }) => { const k = "open"; await myPage[k](); });\n');
  commitAll(dir, 'switch spec to dynamic call');
  writeFile(dir, 'src/pages/MyPage.ts', 'export class MyPage { open(){ return 2; } run(){ const key = "open"; return this[key](); } }\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, selectionBias: 'fail-open' });

  assert.equal(result.hasAnythingToRun, true);
  assert.equal(result.coverageStats.uncertainCallSites >= 1, true);
  assert.equal(Array.from(result.selectionReasons.values()).includes('matched-uncertain-fail-open'), true);
  assert.equal(result.warnings.length > 0, true);
});

test('analyzeImpactedSpecs can drop uncertain-only spec in fail-closed mode', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'tests-app/basic.spec.ts', 'test("x", async ({ myPage }) => { const k = "open"; await myPage[k](); });\n');
  commitAll(dir, 'switch spec to dynamic call');
  writeFile(dir, 'src/pages/MyPage.ts', 'export class MyPage { open(){ return 3; } run(){ const key = "open"; return this[key](); } }\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, selectionBias: 'fail-closed' });
  assert.equal(result.hasAnythingToRun, false);
});

test('analyzeImpactedSpecs keeps deterministic order of selected specs', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'src/pages/MyPage.ts', 'export class MyPage { open(){ return 2; } target(){ return 2; } }\n');
  writeFile(dir, 'tests-app/z.spec.ts', 'test("z", async ({ myPage }) => { await myPage.open(); });\n');
  writeFile(dir, 'tests-app/a.spec.ts', 'test("a", async ({ myPage }) => { await myPage.open(); });\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, includeUntrackedSpecs: true });
  const sorted = [...result.selectedSpecsRelative].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(result.selectedSpecsRelative, sorted);
});

test('analyzeImpactedSpecs combined scenario rename + working tree + optional call selects specs', () => {
  const dir = createBaseRepo();
  run(dir, 'git', ['mv', 'src/pages/MyPage.ts', 'src/pages/MyRenamedPage.ts']);
  commitAll(dir, 'rename page');

  writeFile(dir, 'src/pages/MyRenamedPage.ts', 'export class MyPage { target(){ return 5; } open(){ return this.target(); } }\n');
  writeFile(dir, 'tests-app/basic.spec.ts', 'test("x", async ({ myPage }) => { await myPage?.open?.(); });\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, baseRef: 'HEAD~1', profile: genericProfile, includeWorkingTreeWithBase: true });
  assert.equal(result.hasAnythingToRun, true);
  assert.equal(result.statusSummary.R >= 1 || result.changedPomEntries.some((entry) => entry.status === 'R'), true);
});

test('fail-open selection is never narrower than fail-closed on the same repo state', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'src/pages/MyPage.ts', 'export class MyPage { open(){ return 1; } run(){ const key = "open"; return this[key](); } }\n');
  writeFile(dir, 'tests-app/basic.spec.ts', 'test("x", async ({ myPage }) => { const k = "open"; await myPage[k](); });\n');

  const failOpen = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, selectionBias: 'fail-open' });
  const failClosed = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, selectionBias: 'fail-closed' });

  assert.equal(failOpen.selectedSpecsRelative.length >= failClosed.selectedSpecsRelative.length, true);
});

test('Detect modified POM file (M) and include impacted specs', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'src/pages/MyPage.ts', 'export class MyPage { target(){ return 10; } open(){ return this.target(); } }\\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });
  assert.equal(result.changedPomEntries.some((entry) => entry.status === 'M'), true);
  assert.equal(result.selectedSpecsRelative.includes('tests-app/basic.spec.ts'), true);
});

test('Detect added POM file (A) and include relevant specs', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'src/pages/ExtraPage.ts', 'export class ExtraPage { run(){ return 1; } }\\n');
  writeFile(dir, 'src/fixtures/types.ts', 'type T = {\\n  myPage: Pages.MyPage;\\n  extraPage: Pages.ExtraPage;\\n};\\n');
  writeFile(dir, 'tests-app/extra.spec.ts', 'test(\"x\", async ({ extraPage }) => { await extraPage.run(); });\\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, includeUntrackedSpecs: true });
  assert.equal(result.changedPomEntries.some((entry) => entry.status === 'A'), true);
  assert.equal(result.selectedSpecsRelative.includes('tests-app/extra.spec.ts'), true);
});

test('Detect deleted POM file (D) and include relevant specs', () => {
  const dir = createBaseRepo();
  run(dir, 'git', ['rm', 'src/pages/MyPage.ts']);

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });
  assert.equal(result.changedPomEntries.some((entry) => entry.status === 'D'), true);
  assert.equal(result.selectedSpecsRelative.includes('tests-app/basic.spec.ts'), true);
});

test('Detect renamed POM file (R) and keep semantic comparison old->new', () => {
  const dir = createBaseRepo();
  run(dir, 'git', ['mv', 'src/pages/MyPage.ts', 'src/pages/MyRenamedPage.ts']);

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });
  assert.equal(result.changedPomEntries.some((entry) => entry.status === 'R'), true);
});

test('Rename-only POM change produces no semantic method impact', () => {
  const dir = createBaseRepo();
  run(dir, 'git', ['mv', 'src/pages/MyPage.ts', 'src/pages/MyRenamedPage.ts']);

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });
  assert.equal(result.semanticStats.semanticChangedMethodsCount, 0);
});

test('Rename + method change detects impacted method correctly', () => {
  const dir = createBaseRepo();
  run(dir, 'git', ['mv', 'src/pages/MyPage.ts', 'src/pages/MyRenamedPage.ts']);
  writeFile(dir, 'src/pages/MyRenamedPage.ts', 'export class MyPage { target(){ return 11; } open(){ return this.target(); } }\\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });
  assert.equal(result.semanticStats.semanticChangedMethodsCount >= 1, true);
});

test('Move-only POM file change handled as rename/move', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'src/pages/moved/.keep', '');
  run(dir, 'git', ['mv', 'src/pages/MyPage.ts', 'src/pages/moved/MyPage.ts']);

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });
  assert.equal(result.changedPomEntries.some((entry) => entry.status === 'R'), true);
});

test('Untracked utility file within profile scope impacts selection', () => {
  const dir = createBaseRepo();
  const profileWithUtils = {
    ...genericProfile,
    isRelevantPomPath: (filePath) =>
      (filePath.startsWith('src/pages/') || filePath.startsWith('src/utils/')) &&
      (filePath.endsWith('.ts') || filePath.endsWith('.tsx')),
  };
  writeFile(dir, 'src/utils/Helper.ts', 'export class Helper { run(){ return 1; } }\\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: profileWithUtils });
  assert.equal(result.changedPomEntries.some((entry) => entry.effectivePath === 'src/utils/Helper.ts'), true);
});

test('Filter excludes files outside profile scope', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'external/Outside.ts', 'export class Outside {}\\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });
  assert.equal(result.changedPomEntries.some((entry) => entry.effectivePath === 'external/Outside.ts'), false);
});

test('fileExtensions default includes .ts and .tsx', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'src/pages/Widget.tsx', 'export class Widget { run(){ return 1; } }\\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });
  assert.equal(result.changedPomEntries.some((entry) => entry.effectivePath.endsWith('.tsx')), true);
});

test('fileExtensions custom list limits analysis to specified extensions', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'src/pages/Widget.tsx', 'export class Widget { run(){ return 1; } }\\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, fileExtensions: ['.ts'] });
  assert.equal(result.changedPomEntries.some((entry) => entry.effectivePath.endsWith('.tsx')), false);
});

test('Deterministic ordering of reasons per spec is stable across runs', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'src/pages/MyPage.ts', 'export class MyPage { target(){ return 12; } open(){ return this.target(); } }\\n');

  const first = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });
  const second = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });

  assert.deepEqual(Array.from(first.selectionReasons.entries()), Array.from(second.selectionReasons.entries()));
});

test('Same input produces identical output (determinism test)', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'src/pages/MyPage.ts', 'export class MyPage { target(){ return 13; } open(){ return this.target(); } }\\n');

  const first = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, selectionBias: 'fail-open' });
  const second = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile, selectionBias: 'fail-open' });

  assert.deepEqual(first.selectedSpecsRelative, second.selectedSpecsRelative);
  assert.deepEqual(first.warnings, second.warnings);
  assert.deepEqual(first.coverageStats, second.coverageStats);
  assert.deepEqual(first.changedEntriesBySource, second.changedEntriesBySource);
});

test('Import graph selects spec for changed helper imported directly by relative path', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'src/api/helpers/user-helper.ts', 'export const getUsers = () => 1;\n');
  writeFile(
    dir,
    'tests-app/import-direct.spec.ts',
    'import { getUsers } from "../src/api/helpers/user-helper"; test("x", async () => { getUsers(); });\n'
  );
  commitAll(dir, 'add helper and import spec');

  writeFile(dir, 'src/api/helpers/user-helper.ts', 'export const getUsers = () => 2;\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: profileWithApi, includeUntrackedSpecs: true });
  assert.equal(result.selectedSpecsRelative.includes('tests-app/import-direct.spec.ts'), true);

  const absSpec = path.join(dir, 'tests-app/import-direct.spec.ts');
  assert.equal(result.selectionReasons.get(absSpec), 'matched-import-graph');
});

test('Import graph selects spec for changed helper re-exported through alias barrel', () => {
  const dir = createBaseRepo();
  writeFile(
    dir,
    'tsconfig.json',
    [
      '{',
      '  "compilerOptions": {',
      '    "baseUrl": "./",',
      '    "paths": {',
      '      "@api/*": ["./src/api/*"],',
      '      "@api": ["./src/api"],',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n')
  );
  writeFile(dir, 'src/api/mocks/helpers/setupWizard.mocks.ts', 'export const mockSetup = () => 1;\n');
  writeFile(dir, 'src/api/mocks/index.ts', 'export * from "./helpers/setupWizard.mocks";\n');
  writeFile(
    dir,
    'tests-app/import-barrel.spec.ts',
    'import { mockSetup } from "@api/mocks"; test("x", async () => { mockSetup(); });\n'
  );
  commitAll(dir, 'add alias barrel and spec');

  writeFile(dir, 'src/api/mocks/helpers/setupWizard.mocks.ts', 'export const mockSetup = () => 2;\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: profileWithApi, includeUntrackedSpecs: true });
  assert.equal(result.selectedSpecsRelative.includes('tests-app/import-barrel.spec.ts'), true);

  const absSpec = path.join(dir, 'tests-app/import-barrel.spec.ts');
  assert.equal(result.selectionReasons.get(absSpec), 'matched-import-graph');
});

test('Import graph selects spec for changed json asset referenced by helper', () => {
  const dir = createBaseRepo();
  writeFile(
    dir,
    'tsconfig.json',
    [
      '{',
      '  "compilerOptions": {',
      '    "baseUrl": "./",',
      '    "paths": {',
      '      "@api/*": ["./src/api/*"],',
      '      "@api": ["./src/api"],',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n')
  );
  writeFile(
    dir,
    'src/api/mocks/helpers/setupWizard.mocks.ts',
    'export const mockSetup = async (graphqlMock) => graphqlMock.mockOperations("getAcademicPeriods", "getAcademicPeriods.completed.json");\n'
  );
  writeFile(dir, 'src/api/mocks/helpers/getAcademicPeriods.completed.json', '{"items":[1]}\n');
  writeFile(dir, 'src/api/mocks/index.ts', 'export * from "./helpers/setupWizard.mocks";\n');
  writeFile(
    dir,
    'tests-app/import-json-asset.spec.ts',
    'import { mockSetup } from "@api/mocks"; test("x", async ({ graphqlMock }) => { await mockSetup(graphqlMock); });\n'
  );
  commitAll(dir, 'add json mock asset and spec');

  writeFile(dir, 'src/api/mocks/helpers/getAcademicPeriods.completed.json', '{"items":[2]}\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: profileWithApiAllFiles, includeUntrackedSpecs: true });
  assert.equal(result.selectedSpecsRelative.includes('tests-app/import-json-asset.spec.ts'), true);

  const absSpec = path.join(dir, 'tests-app/import-json-asset.spec.ts');
  assert.equal(result.selectionReasons.get(absSpec), 'matched-import-graph');
});

test('Global watch change in playwright.stem.config.ts forces all project specs', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'playwright.stem.config.ts', 'export default {};\n');
  writeFile(dir, 'tests-app/another.spec.ts', 'test("y", async ({ myPage }) => { await myPage.open(); });\n');
  commitAll(dir, 'add stem config and second spec');

  writeFile(dir, 'playwright.stem.config.ts', 'export default { retries: 1 };\n');

  const result = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });
  assert.equal(result.forcedAllSpecs, true);
  assert.equal(result.forcedAllSpecsReason, 'global-watch-force-all');
  assert.equal(result.selectedSpecsRelative.includes('tests-app/basic.spec.ts'), true);
  assert.equal(result.selectedSpecsRelative.includes('tests-app/another.spec.ts'), true);
  assert.equal(Array.from(result.selectionReasons.values()).every((reason) => reason === 'global-watch-force-all'), true);
});

test('Global watch change in src/global-setup-mn.ts forces all mathnation specs', () => {
  const dir = createTempDir();
  initGitRepo(dir);
  writeFile(dir, 'src/global-setup-mn.ts', 'export default async () => {};\n');
  writeFile(dir, 'tests-mathnation/a.spec.ts', 'test("a", async () => {});\n');
  writeFile(dir, 'tests-mathnation/b.spec.ts', 'test("b", async () => {});\n');
  writeFile(dir, 'src/fixtures/types.ts', 'type T = {};\n');
  commitAll(dir, 'base mn');

  writeFile(dir, 'src/global-setup-mn.ts', 'export default async () => { return 1; };\n');

  const result = analyzeImpactedSpecs({
    repoRoot: dir,
    profile: {
      ...genericProfile,
      testsRootRelative: 'tests-mathnation',
      changedSpecPrefix: 'tests-mathnation/',
    },
  });
  assert.equal(result.forcedAllSpecs, true);
  assert.deepEqual(result.selectedSpecsRelative, ['tests-mathnation/a.spec.ts', 'tests-mathnation/b.spec.ts']);
});

test('Global watch can be disabled and falls back to selective behavior', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'playwright.stem.config.ts', 'export default {};\n');
  commitAll(dir, 'add config');
  writeFile(dir, 'playwright.stem.config.ts', 'export default { retries: 2 };\n');

  const result = analyzeImpactedSpecs({
    repoRoot: dir,
    profile: {
      ...genericProfile,
      globalWatchMode: 'disabled',
    },
  });
  assert.equal(result.forcedAllSpecs, false);
  assert.equal(result.hasAnythingToRun, false);
});

test('Global watch force-all output is deterministic across runs', () => {
  const dir = createBaseRepo();
  writeFile(dir, 'src/global-setup-stem.ts', 'export default async () => {};\n');
  writeFile(dir, 'tests-app/aaa.spec.ts', 'test("a", async ({ myPage }) => { await myPage.open(); });\n');
  commitAll(dir, 'base global setup');
  writeFile(dir, 'src/global-setup-stem.ts', 'export default async () => { return true; };\n');

  const first = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });
  const second = analyzeImpactedSpecs({ repoRoot: dir, profile: genericProfile });

  assert.deepEqual(first.selectedSpecsRelative, second.selectedSpecsRelative);
  assert.deepEqual(Array.from(first.selectionReasons.entries()), Array.from(second.selectionReasons.entries()));
});
