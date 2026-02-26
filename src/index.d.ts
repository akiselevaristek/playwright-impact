export type ChangedEntryStatus = 'A' | 'M' | 'D' | 'R';

export type ChangedEntry = {
  status: ChangedEntryStatus;
  oldPath: string | null;
  newPath: string | null;
  effectivePath: string;
  rawStatus?: string;
};

export type AnalyzeProfile = {
  testsRootRelative: string;
  changedSpecPrefix: string;
  isRelevantPomPath: (filePath: string) => boolean;
  analysisRootsRelative?: string[];
  fixturesTypesRelative?: string;
  globalWatchPatterns?: string[];
  globalWatchMode?: 'force-all-in-project' | 'disabled';
};

export type AnalyzeOptions = {
  repoRoot: string;
  baseRef?: string | null;
  profile: AnalyzeProfile;
  includeUntrackedSpecs?: boolean;
  includeWorkingTreeWithBase?: boolean;
  fileExtensions?: string[];
  selectionBias?: 'fail-open' | 'balanced' | 'fail-closed';
};

export type AnalyzeResult = {
  selectedSpecs: string[];
  selectedSpecsRelative: string[];
  changedPomEntries: ChangedEntry[];
  directChangedSpecFiles: string[];
  statusSummary: { A: number; M: number; D: number; R: number };
  impactedClasses: Set<string>;
  impactedMethodsByClass: Map<string, Set<string>>;
  fixtureKeys: Set<string>;
  stageASelectedCount: number;
  semanticStats: {
    changedPomEntriesByStatus: { A: number; M: number; D: number; R: number };
    semanticChangedMethodsCount: number;
    topLevelRuntimeChangedFiles: number;
  };
  propagationStats: { impactedMethodsTotal: number };
  droppedByMethodFilter: number;
  retainedWithoutMethodFilter: number;
  selectionReasons: Map<string, string>;
  hasAnythingToRun: boolean;
  warnings: string[];
  coverageStats: {
    uncertainCallSites: number;
    statusFallbackHits: number;
  };
  changedEntriesBySource: {
    fromBaseHead: number;
    fromWorkingTree: number;
    fromUntracked: number;
  };
  forcedAllSpecs: boolean;
  forcedAllSpecsReason: string | null;
  globalWatchMatches: string[];
  globalWatchResolvedFiles: string[];
};

export function analyzeImpactedSpecs(options: AnalyzeOptions): AnalyzeResult;

export function formatSelectionReasonsForLog(args: {
  selectedSpecs: string[];
  selectionReasons: Map<string, string>;
  repoRoot: string;
  maxLines?: number;
}): string;
