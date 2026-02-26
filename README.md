# Playwright Test Impact

If you use Playwright + POM and your CI runs are slow, this library selects only specs affected by your changes.

It reads changed files, finds impacted specs, and helps you run only what matters.

## Install

```bash
// npm
npm i @autotests/playwright-impact

// pnpm
pnpm add @autotests/playwright-impact
```

## Quick Start (Copy & Run)

### Minimal working code

Create `impact.js` in your repo root:

```js
const { analyzeImpactedSpecs } = require('@autotests/playwright-impact');

const result = analyzeImpactedSpecs({
  repoRoot: process.cwd(),
  profile: {
    testsRootRelative: 'tests',
    changedSpecPrefix: 'tests/',
    isRelevantPomPath: (filePath) =>
      (filePath.startsWith('src/pages/') || filePath.startsWith('src/utils/')) &&
      (filePath.endsWith('.ts') || filePath.endsWith('.tsx')),
  },
});

if (!result.hasAnythingToRun) {
  console.log('No impacted specs found');
  process.exit(0);
}

for (const spec of result.selectedSpecsRelative) {
  console.log(spec);
}
```

Save as `impact.js`

Run: `node impact.js`

Use output paths in your Playwright CLI

### What you need to change

You only need to adjust:

- `testsRootRelative`: folder where your Playwright specs live.
- `changedSpecPrefix`: prefix used to detect directly changed specs.
- `isRelevantPomPath`: rule for which source files are treated as POM/utility inputs.

### Example output

Example output:

```text
tests/auth/login.spec.ts
tests/cart/cart.spec.ts
```

If nothing is impacted:

```text
No impacted specs found
```

## Minimal CI Script

Use this when your branch is compared to `origin/main`.

```js
const { analyzeImpactedSpecs } = require('@autotests/playwright-impact');

const result = analyzeImpactedSpecs({
  repoRoot: process.cwd(),
  baseRef: 'origin/main',
  profile: {
    testsRootRelative: 'tests',
    changedSpecPrefix: 'tests/',
    isRelevantPomPath: (filePath) =>
      (filePath.startsWith('src/pages/') || filePath.startsWith('src/utils/')) &&
      (filePath.endsWith('.ts') || filePath.endsWith('.tsx')),
  },
});

if (!result.hasAnythingToRun) {
  console.log('No impacted specs found');
  process.exit(0);
}

console.log(result.selectedSpecsRelative.join(' '));
```

## Typical CI Usage

1. Compare current branch with `origin/main`.
2. Compute impacted specs.
3. Exit with `0` if nothing should run.
4. Pass `selectedSpecsRelative` to your Playwright runner.

## How It Works (High Level)

1. Read changed files from Git.
2. Include directly changed specs.
3. Detect impacted specs from changed POM/utility code.
4. Return a final spec list.

## Advanced Config

Required:

- `repoRoot`
- `profile.testsRootRelative`
- `profile.changedSpecPrefix`
- `profile.isRelevantPomPath(filePath)`

Optional:

- `analysisRootsRelative`
- `fixturesTypesRelative`
- `baseRef`
- `includeUntrackedSpecs`
- `includeWorkingTreeWithBase`
- `fileExtensions`
- `selectionBias`

## Advanced Diagnostics

- `warnings`
- `selectionReasons`
- `coverageStats.uncertainCallSites`
- `coverageStats.statusFallbackHits`
- `changedEntriesBySource`

## Reason Codes

- `direct-changed-spec`
- `matched-precise`
- `matched-uncertain-fail-open`
- `retained-no-bindings`
