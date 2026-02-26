'use strict';

const fs = require('fs');
const path = require('path');
const {
  SUPPORTED_FILE_EXTENSIONS,
  listFilesRecursive,
  getChangedEntries,
  readChangeContents,
  getUntrackedSpecPaths,
} = require('./modules/file-and-git-helpers');
const { buildInheritanceGraph, collectImpactedClasses, getFixtureKeysForClasses } = require('./modules/class-impact-helpers');
const { parseFixtureMappings } = require('./modules/fixture-map-helpers');
const { collectChangedMethodsByClass, buildImpactedMethodsByClass } = require('./modules/method-impact-helpers');
const { selectSpecFiles } = require('./modules/spec-selection-helpers');
const { filterSpecsByImpactedMethods } = require('./modules/method-filter-helpers');
const { selectSpecsByChangedImports } = require('./modules/import-impact-helpers');
const { evaluateGlobalWatch, getDefaultGlobalWatchPatterns } = require('./modules/global-watch-helpers');

const DIRECT_CHANGED_SPEC_STATUSES = new Set(['A', 'M', 'R']);
const DEFAULT_SELECTION_BIAS = 'fail-open';
const DEFAULT_GLOBAL_WATCH_MODE = 'force-all-in-project';

const getStatusSummary = (entries) => {
  const summary = { A: 0, M: 0, D: 0, R: 0 };
  for (const entry of entries) {
    if (summary[entry.status] !== undefined) summary[entry.status] += 1;
  }
  return summary;
};

const validateProfile = (profile) => {
  if (!profile || typeof profile !== 'object') throw new Error('Missing required profile configuration');
  if (!profile.testsRootRelative) throw new Error('Missing profile.testsRootRelative');
  if (!profile.changedSpecPrefix) throw new Error('Missing profile.changedSpecPrefix');
  if (typeof profile.isRelevantPomPath !== 'function') throw new Error('Missing profile.isRelevantPomPath(filePath) function');
};

const normalizeFileExtensions = (fileExtensions) => {
  const source = Array.isArray(fileExtensions) && fileExtensions.length > 0 ? fileExtensions : Array.from(SUPPORTED_FILE_EXTENSIONS);
  const normalized = source
    .map((ext) => String(ext || '').trim().toLowerCase())
    .filter((ext) => ext.startsWith('.'));
  return normalized.length > 0 ? Array.from(new Set(normalized)) : Array.from(SUPPORTED_FILE_EXTENSIONS);
};

/**
 * Analyze changed sources and return the deterministic list of impacted spec files.
 * Pipeline:
 * 1) collect and normalize changed entries from git/untracked sources
 * 2) seed semantic impact from changed POM classes/methods
 * 3) Stage A preselect specs by impacted fixture keys
 * 4) Stage B precise/uncertain method matching with selection bias policy
 */
const analyzeImpactedSpecs = ({
  repoRoot,
  baseRef = null,
  profile,
  includeUntrackedSpecs = true,
  includeWorkingTreeWithBase = true,
  fileExtensions = ['.ts', '.tsx'],
  selectionBias = DEFAULT_SELECTION_BIAS,
}) => {
  validateProfile(profile);
  if (!repoRoot) throw new Error('Missing required repoRoot');

  const effectiveExtensions = normalizeFileExtensions(fileExtensions);
  const testsRoot = path.join(repoRoot, profile.testsRootRelative);
  const analysisRootsRelative = profile.analysisRootsRelative || ['src/pages', 'src/utils'];
  const fixturesTypesRelative = profile.fixturesTypesRelative || 'src/fixtures/types.ts';
  const globalWatchMode = profile.globalWatchMode || DEFAULT_GLOBAL_WATCH_MODE;
  const globalWatchPatterns = Array.isArray(profile.globalWatchPatterns) && profile.globalWatchPatterns.length > 0
    ? profile.globalWatchPatterns
    : getDefaultGlobalWatchPatterns();

  // Stage 0: gather changed files and keep only profile-relevant subsets.
  const changedEntriesResult = getChangedEntries({
    repoRoot,
    baseRef,
    includeWorkingTreeWithBase,
    profile,
    fileExtensions: effectiveExtensions,
  });
  const changedEntries = changedEntriesResult.entries;
  const changedPomEntries = changedEntries.filter((entry) => {
    const candidates = [entry.effectivePath, entry.oldPath, entry.newPath].filter(Boolean);
    return candidates.some((filePath) => profile.isRelevantPomPath(filePath));
  });
  const changedSpecEntries = changedEntries.filter((entry) => {
    const targetPath = String(entry.effectivePath || '').trim();
    return targetPath.startsWith(profile.changedSpecPrefix) && effectiveExtensions.some((ext) => targetPath.endsWith(`.spec${ext}`));
  });
  const globalWatch = globalWatchMode === 'disabled'
    ? { matchedPaths: [], resolvedFiles: [] }
    : evaluateGlobalWatch({
      repoRoot,
      changedEntries,
      patterns: globalWatchPatterns,
      listFilesRecursive,
    });

  const changedSpecFiles = changedSpecEntries
    .filter((entry) => DIRECT_CHANGED_SPEC_STATUSES.has(entry.status))
    .map((entry) => entry.effectivePath)
    .filter(Boolean);
  const untrackedSpecFiles = includeUntrackedSpecs
    ? getUntrackedSpecPaths({ repoRoot, changedSpecPrefix: profile.changedSpecPrefix, fileExtensions: effectiveExtensions })
    : [];
  const directChangedSpecFiles = Array.from(new Set([...changedSpecFiles, ...untrackedSpecFiles])).sort((a, b) => a.localeCompare(b));

  if (globalWatchMode !== 'disabled' && globalWatch.matchedPaths.length > 0) {
    const selectedSpecs = listFilesRecursive(testsRoot)
      .filter((filePath) => effectiveExtensions.some((ext) => filePath.endsWith(`.spec${ext}`)))
      .sort((a, b) => a.localeCompare(b));
    const selectionReasons = new Map(selectedSpecs.map((specPath) => [specPath, 'global-watch-force-all']));

    return {
      selectedSpecs,
      selectedSpecsRelative: selectedSpecs.map((specPath) => path.relative(repoRoot, specPath)),
      changedPomEntries,
      directChangedSpecFiles,
      statusSummary: getStatusSummary(changedPomEntries),
      impactedClasses: new Set(),
      impactedMethodsByClass: new Map(),
      fixtureKeys: new Set(),
      stageASelectedCount: selectedSpecs.length,
      semanticStats: { changedPomEntriesByStatus: { A: 0, M: 0, D: 0, R: 0 }, semanticChangedMethodsCount: 0, topLevelRuntimeChangedFiles: 0 },
      propagationStats: { impactedMethodsTotal: 0 },
      droppedByMethodFilter: 0,
      retainedWithoutMethodFilter: 0,
      selectionReasons,
      hasAnythingToRun: selectedSpecs.length > 0,
      warnings: changedEntriesResult.warnings,
      coverageStats: { uncertainCallSites: 0, statusFallbackHits: changedEntriesResult.statusFallbackHits },
      changedEntriesBySource: changedEntriesResult.changedEntriesBySource,
      forcedAllSpecs: true,
      forcedAllSpecsReason: 'global-watch-force-all',
      globalWatchMatches: globalWatch.matchedPaths,
      globalWatchResolvedFiles: globalWatch.resolvedFiles,
    };
  }

  // Fast exit when neither changed POM files nor direct changed specs are present.
  if (changedPomEntries.length === 0 && directChangedSpecFiles.length === 0) {
    return {
      selectedSpecs: [],
      selectedSpecsRelative: [],
      changedPomEntries,
      directChangedSpecFiles,
      statusSummary: getStatusSummary(changedPomEntries),
      impactedClasses: new Set(),
      impactedMethodsByClass: new Map(),
      fixtureKeys: new Set(),
      stageASelectedCount: 0,
      semanticStats: { changedPomEntriesByStatus: { A: 0, M: 0, D: 0, R: 0 }, semanticChangedMethodsCount: 0, topLevelRuntimeChangedFiles: 0 },
      propagationStats: { impactedMethodsTotal: 0 },
      droppedByMethodFilter: 0,
      retainedWithoutMethodFilter: 0,
      selectionReasons: new Map(),
      hasAnythingToRun: false,
      warnings: changedEntriesResult.warnings,
      coverageStats: { uncertainCallSites: 0, statusFallbackHits: changedEntriesResult.statusFallbackHits },
      changedEntriesBySource: changedEntriesResult.changedEntriesBySource,
      forcedAllSpecs: false,
      forcedAllSpecsReason: null,
      globalWatchMatches: globalWatch.matchedPaths,
      globalWatchResolvedFiles: globalWatch.resolvedFiles,
    };
  }

  let impactedClasses = new Set();
  let impactedMethodsByClass = new Map();
  let fixtureKeys = new Set();
  let fixtureKeyToClass = new Map();
  let selectedSpecs = [];
  let stageASelectedCount = 0;
  let semanticStats = {
    changedPomEntriesByStatus: { A: 0, M: 0, D: 0, R: 0 },
    semanticChangedMethodsCount: 0,
    topLevelRuntimeChangedFiles: 0,
  };
  let propagationStats = { impactedMethodsTotal: 0 };
  let propagationWarnings = [];
  let importMatchedSpecs = [];

  const pageFiles = analysisRootsRelative
    .flatMap((relativePath) => listFilesRecursive(path.join(repoRoot, relativePath)))
    .filter((filePath) => effectiveExtensions.includes(path.extname(filePath).toLowerCase()));
  const { parentsByChild, childrenByParent } = buildInheritanceGraph(pageFiles, fs.readFileSync);

  if (changedPomEntries.length > 0) {
    importMatchedSpecs = selectSpecsByChangedImports({
      repoRoot,
      testsRootAbs: testsRoot,
      changedPomEntries,
      listFilesRecursive,
      fileExtensions: effectiveExtensions,
    });
  }

  // Stage 1: semantic seed and callgraph propagation from changed POM entries.
  if (changedPomEntries.length > 0) {
    const changedMethodsResult = collectChangedMethodsByClass({
      changedPomEntries,
      baseRef,
      readChangeContents: (entry, entryBaseRef) => readChangeContents({ repoRoot, entry, baseRef: entryBaseRef }),
    });

    semanticStats = changedMethodsResult.stats;
    const hasSemanticPomImpact = semanticStats.semanticChangedMethodsCount > 0 || semanticStats.topLevelRuntimeChangedFiles > 0;

    if (hasSemanticPomImpact) {
      impactedClasses = collectImpactedClasses({
        changedPomEntries,
        childrenByParent,
        baseRef,
        readChangeContents: (entry, entryBaseRef) => readChangeContents({ repoRoot, entry, baseRef: entryBaseRef }),
      });

      const impactedMethodsResult = buildImpactedMethodsByClass({
        impactedClasses,
        changedMethodsByClass: changedMethodsResult.changedMethodsByClass,
        parentsByChild,
        pageFiles,
      });

      impactedMethodsByClass = impactedMethodsResult.impactedMethodsByClass;
      propagationStats = impactedMethodsResult.stats;
      propagationWarnings = impactedMethodsResult.warnings || [];

      const fixtureMappings = parseFixtureMappings({ typesPath: path.join(repoRoot, fixturesTypesRelative) });
      fixtureKeyToClass = fixtureMappings.fixtureKeyToClass;
      const classesForFixtureSelection = impactedMethodsByClass.size > 0 ? new Set(impactedMethodsByClass.keys()) : impactedClasses;
      fixtureKeys = getFixtureKeysForClasses(classesForFixtureSelection, fixtureMappings.classToFixtureKeys);

      // Stage A: fixture-key prefilter to avoid scanning unrelated specs in Stage B.
      if (fixtureKeys.size > 0) {
        selectedSpecs = selectSpecFiles({ testsRootAbs: testsRoot, fixtureKeys, listFilesRecursive, fileExtensions: effectiveExtensions });
        stageASelectedCount = selectedSpecs.length;
      }
    }
  }

  // Directly changed specs are always added after Stage A prefilter.
  const directChangedSpecsAbs = directChangedSpecFiles.map((filePath) => path.join(repoRoot, filePath));
  const selectedSet = new Set([...selectedSpecs, ...directChangedSpecsAbs, ...importMatchedSpecs]);
  selectedSpecs = Array.from(selectedSet).sort((a, b) => a.localeCompare(b));
  stageASelectedCount = selectedSpecs.length;

  // Stage B: method-level filtering with fail-open/fail-closed handling for uncertain call sites.
  const methodFilterResult = filterSpecsByImpactedMethods({
    selectedSpecs,
    directChangedSpecsAbs,
    alwaysIncludeSpecsAbs: importMatchedSpecs,
    fixtureKeyToClass,
    fixtureKeys,
    impactedMethodsByClass,
    selectionBias,
  });

  selectedSpecs = methodFilterResult.filteredSpecs;

  return {
    selectedSpecs,
    selectedSpecsRelative: selectedSpecs.map((specPath) => path.relative(repoRoot, specPath)),
    changedPomEntries,
    directChangedSpecFiles,
    statusSummary: getStatusSummary(changedPomEntries),
    impactedClasses,
    impactedMethodsByClass,
    fixtureKeys,
    stageASelectedCount,
    semanticStats,
    propagationStats,
    droppedByMethodFilter: methodFilterResult.droppedByMethodFilter,
    retainedWithoutMethodFilter: methodFilterResult.retainedWithoutMethodFilter,
    selectionReasons: methodFilterResult.selectionReasons,
    hasAnythingToRun: selectedSpecs.length > 0,
    warnings: [...changedEntriesResult.warnings, ...propagationWarnings, ...methodFilterResult.warnings],
    coverageStats: {
      uncertainCallSites: methodFilterResult.uncertainCallSites,
      statusFallbackHits: changedEntriesResult.statusFallbackHits,
    },
    changedEntriesBySource: changedEntriesResult.changedEntriesBySource,
    forcedAllSpecs: false,
    forcedAllSpecsReason: null,
    globalWatchMatches: globalWatch.matchedPaths,
    globalWatchResolvedFiles: globalWatch.resolvedFiles,
  };
};

module.exports = {
  analyzeImpactedSpecs,
};
