# test-impact-core

Core library for selecting impacted Playwright specs from changed POM methods.

## Install

```bash
// npm
npm i @autotests/test-impact-core

// pnpm
pnpm add @autotests/test-impact-core
```

## Public API

```js
const { analyzeImpactedSpecs } = require('@autotests/test-impact-core');
```

## Quick start

```js
const { analyzeImpactedSpecs } = require('@autotests/test-impact-core');

const repoRoot = process.cwd();

const profile = {
  // Root directory where your Playwright specs live.
  testsRootRelative: 'tests-app',
  // Prefix used to mark directly changed specs from git diff output.
  changedSpecPrefix: 'tests-app/',
  // Your project-specific "what is a relevant POM/utility source file" rule.
  isRelevantPomPath: (filePath) =>
    (filePath.startsWith('src/pages/') || filePath.startsWith('src/utils/')) &&
    (filePath.endsWith('.ts') || filePath.endsWith('.tsx')),
  // Directories scanned to build inheritance and call graphs.
  analysisRootsRelative: ['src/pages', 'src/utils'],
  // File used to map fixture keys to class names.
  fixturesTypesRelative: 'src/fixtures/types.ts',
};

const result = analyzeImpactedSpecs({
  repoRoot,
  baseRef: 'origin/main',
  profile,
});

if (!result.hasAnythingToRun) {
  console.log('No impacted specs found');
  process.exit(0);
}

console.log('Run impacted specs only:');
for (const spec of result.selectedSpecsRelative) {
  console.log(spec);
}
```

## Configuration

### `analyzeImpactedSpecs(options)`

- `repoRoot` (required): absolute path to repository root.
- `profile` (required): project configuration object.
- `baseRef` (optional): git ref for comparison (example: `origin/main`).
- `includeUntrackedSpecs` (optional, default `true`): include untracked `*.spec.ts`/`*.spec.tsx` as direct changed specs.
- `includeWorkingTreeWithBase` (optional, default `true`): when `baseRef` is set, union committed diff (`base...HEAD`) with current working tree diff (`HEAD`).
- `fileExtensions` (optional, default `['.ts', '.tsx']`): file extensions to analyze.
- `selectionBias` (optional, default `'fail-open'`): uncertain call-site behavior.

### `profile` fields

- `testsRootRelative` (required): tests root relative path.
- `changedSpecPrefix` (required): prefix for direct changed spec detection.
- `isRelevantPomPath(filePath)` (required): function that returns true for relevant POM/utility files.
- `analysisRootsRelative` (optional): roots for class/method graph scan. Default: `['src/pages', 'src/utils']`.
- `fixturesTypesRelative` (optional): fixture map file path. Default: `src/fixtures/types.ts`.

## Common usage patterns

### 1) CI mode (compare feature branch against main)

```js
const { analyzeImpactedSpecs } = require('@autotests/test-impact-core');

const result = analyzeImpactedSpecs({
  repoRoot: process.cwd(),
  baseRef: 'origin/main',
  includeWorkingTreeWithBase: true,
  includeUntrackedSpecs: true,
  selectionBias: 'fail-open',
  profile: {
    testsRootRelative: 'tests',
    changedSpecPrefix: 'tests/',
    isRelevantPomPath: (filePath) => filePath.startsWith('src/pages/') && (filePath.endsWith('.ts') || filePath.endsWith('.tsx')),
    analysisRootsRelative: ['src/pages', 'src/utils'],
    fixturesTypesRelative: 'src/fixtures/types.ts',
  },
});

console.log(result.selectedSpecsRelative);
```

### 2) Strict mode (drop uncertain matches)

```js
const { analyzeImpactedSpecs } = require('@autotests/test-impact-core');

const result = analyzeImpactedSpecs({
  repoRoot: process.cwd(),
  profile,
  selectionBias: 'fail-closed',
});

console.log(result.selectedSpecsRelative);
```

### 3) Custom extensions

```js
const { analyzeImpactedSpecs } = require('@autotests/test-impact-core');

const result = analyzeImpactedSpecs({
  repoRoot: process.cwd(),
  profile,
  fileExtensions: ['.ts'], // ignore .tsx
});

console.log(result.selectedSpecsRelative);
```

## Result fields you usually need

- `selectedSpecsRelative`: relative paths for your test runner CLI.
- `hasAnythingToRun`: quick boolean for early exit.
- `selectionReasons`: reason code per selected spec.
- `warnings`: compatibility or uncertainty warnings.
- `coverageStats.uncertainCallSites`: count of uncertain call sites encountered.
- `coverageStats.statusFallbackHits`: count of git status fallbacks (`C/T/U/unknown`).
- `changedEntriesBySource`: diagnostics for diff sources (`base...HEAD`, working tree, untracked).

Example:

```js
for (const [absPath, reason] of result.selectionReasons.entries()) {
  console.log(reason, absPath);
}

if (result.warnings.length > 0) {
  console.warn('Warnings:');
  for (const warning of result.warnings) console.warn(`- ${warning}`);
}
```

## Reason codes

- `direct-changed-spec`: spec was directly changed in git/untracked set.
- `matched-precise`: spec has precise impacted fixture method usage.
- `matched-uncertain-fail-open`: uncertain match retained by fail-open policy.
- `retained-no-bindings`: spec kept because no fixture bindings were found in callback params.

## Notes

- This library is intentionally pragmatic and defaults to `selectionBias: 'fail-open'`.
- For maximum safety, use `fail-open` in CI and monitor `warnings`/`uncertainCallSites`.
- Use deterministic input (`baseRef`, clean profile predicates) for deterministic output.
