'use strict';

const fs = require('fs');
const path = require('path');
const { runCommand } = require('./shell');

const STATUS_PRIORITY = { D: 4, R: 3, M: 2, A: 1 };
const SUPPORTED_FILE_EXTENSIONS = new Set(['.ts', '.tsx']);

const readFileFromBaseRef = ({ repoRoot, relativePath, baseRef }) => {
  if (!relativePath) return null;
  const effectiveBaseRef = String(baseRef || 'HEAD').trim();
  if (!effectiveBaseRef) return null;
  const showResult = runCommand('git', ['show', `${effectiveBaseRef}:${relativePath}`], { cwd: repoRoot });
  if (showResult.status !== 0 || showResult.error) return null;
  return typeof showResult.stdout === 'string' ? showResult.stdout : null;
};

const readFileFromWorkingTree = ({ repoRoot, relativePath }) => {
  if (!relativePath) return null;
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return null;
  return fs.readFileSync(absolutePath, 'utf8');
};

const parseChangedEntryLine = (line) => {
  const parts = line.split('\t').filter(Boolean);
  if (parts.length < 2) return null;

  const rawStatus = String(parts[0] || '').trim().toUpperCase();
  if (!rawStatus) return null;

  if (rawStatus.startsWith('R') || rawStatus.startsWith('C')) {
    const oldPath = String(parts[1] || '').trim();
    const newPath = String(parts[2] || '').trim();
    if (!oldPath || !newPath) return null;
    return {
      status: rawStatus.startsWith('R') ? 'R' : 'C',
      oldPath,
      newPath,
      effectivePath: newPath,
      rawStatus,
    };
  }

  const shortStatus = rawStatus[0];
  const targetPath = String(parts[1] || '').trim();
  if (!targetPath) return null;

  return {
    status: shortStatus,
    oldPath: shortStatus === 'A' ? null : targetPath,
    newPath: shortStatus === 'D' ? null : targetPath,
    effectivePath: targetPath,
    rawStatus,
  };
};

const listFilesRecursive = (rootDir) => {
  if (!fs.existsSync(rootDir)) return [];
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(nextPath);
      else files.push(nextPath);
    }
  }

  return files;
};

const runDiffAndParse = ({ repoRoot, args }) => {
  // Use rename detection to keep semantic compare stable across pure file moves/renames.
  const result = runCommand('git', ['diff', '--name-status', '-M', ...args], { cwd: repoRoot });
  if (result.error) throw new Error(`Failed to execute git diff: ${result.error.message}`);
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new Error(`git diff failed with code ${result.status}: ${details}`);
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseChangedEntryLine)
    .filter((entry) => Boolean(entry));
};

const normalizeEntryStatus = (entry, warnings) => {
  // Compatibility fallback:
  // - C behaves like an add because there is no stable base path identity
  // - T/U/unknown behave like modify to preserve fail-open behavior
  const status = String(entry.status || '').toUpperCase();
  if (['A', 'M', 'D', 'R'].includes(status)) return { ...entry, status };

  if (status === 'C') {
    warnings.push(`Status fallback: ${entry.rawStatus || 'C'} mapped to A for ${entry.effectivePath}`);
    return { ...entry, status: 'A', oldPath: null };
  }

  if (status === 'T' || status === 'U') {
    warnings.push(`Status fallback: ${entry.rawStatus || status} mapped to M for ${entry.effectivePath}`);
    return { ...entry, status: 'M', oldPath: entry.oldPath || entry.effectivePath, newPath: entry.newPath || entry.effectivePath };
  }

  warnings.push(`Status fallback: ${entry.rawStatus || status || 'unknown'} mapped to M for ${entry.effectivePath}`);
  return { ...entry, status: 'M', oldPath: entry.oldPath || entry.effectivePath, newPath: entry.newPath || entry.effectivePath };
};

const mergeByPriority = (existing, incoming) => {
  if (!existing) return incoming;
  const currentPriority = STATUS_PRIORITY[existing.status] || 0;
  const incomingPriority = STATUS_PRIORITY[incoming.status] || 0;
  if (incomingPriority > currentPriority) return incoming;
  if (incomingPriority < currentPriority) return existing;

  // If priorities are equal, keep entry with richer rename info.
  if (incoming.status === 'R' && incoming.oldPath && incoming.newPath) return incoming;
  return existing;
};

const isValidExtension = (filePath, fileExtensions) => {
  const ext = path.extname(filePath);
  return fileExtensions.includes(ext);
};

const getUntrackedPaths = ({ repoRoot }) => {
  const result = runCommand('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repoRoot });
  if (result.error || result.status !== 0) return [];

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
};

const getUntrackedSpecPaths = ({ repoRoot, changedSpecPrefix, fileExtensions = ['.ts', '.tsx'] }) => {
  return getUntrackedPaths({ repoRoot })
    .filter((filePath) => filePath.startsWith(changedSpecPrefix))
    .filter((filePath) => fileExtensions.some((ext) => filePath.endsWith(`.spec${ext}`)));
};

const getUntrackedSourceEntries = ({ repoRoot, profile, fileExtensions = ['.ts', '.tsx'] }) => {
  return getUntrackedPaths({ repoRoot })
    .filter((filePath) => isValidExtension(filePath, fileExtensions))
    .filter((filePath) => profile.isRelevantPomPath(filePath))
    .map((filePath) => ({
      status: 'A',
      oldPath: null,
      newPath: filePath,
      effectivePath: filePath,
      rawStatus: 'A (untracked source)',
    }));
};

/**
 * Build normalized changed entries for analysis.
 * Sources:
 * - git diff <base>...HEAD (if baseRef is set)
 * - git diff HEAD (working tree, optionally merged with base mode)
 * - untracked source files matching profile.isRelevantPomPath
 */
const getChangedEntries = ({ repoRoot, baseRef, includeWorkingTreeWithBase = true, profile = null, fileExtensions = ['.ts', '.tsx'] }) => {
  const warnings = [];
  let statusFallbackHits = 0;

  const baseHeadEntries = baseRef ? runDiffAndParse({ repoRoot, args: [`${baseRef}...HEAD`] }) : [];
  const workingTreeEntries = (!baseRef || includeWorkingTreeWithBase) ? runDiffAndParse({ repoRoot, args: ['HEAD'] }) : [];
  const combined = [...baseHeadEntries, ...workingTreeEntries];

  if (!baseRef && combined.length === 0) {
    // Keep backward-compatible behavior for local-only mode where `HEAD` diff is the primary source.
    combined.push(...workingTreeEntries);
  }

  if (profile && typeof profile.isRelevantPomPath === 'function') {
    combined.push(...getUntrackedSourceEntries({ repoRoot, profile, fileExtensions }));
  }

  // Deterministic status merge by effective path with explicit precedence (D > R > M > A).
  const mergedByPath = new Map();
  for (const entry of combined) {
    const normalized = normalizeEntryStatus(entry, warnings);
    if (!['A', 'M', 'D', 'R'].includes(normalized.status)) continue;
    if (normalized.status !== entry.status) statusFallbackHits += 1;

    const key = normalized.effectivePath;
    const existing = mergedByPath.get(key);
    mergedByPath.set(key, mergeByPriority(existing, normalized));
  }

  const entries = Array.from(mergedByPath.values()).sort((a, b) => a.effectivePath.localeCompare(b.effectivePath));

  return {
    entries,
    warnings,
    statusFallbackHits,
    changedEntriesBySource: {
      fromBaseHead: baseHeadEntries.length,
      fromWorkingTree: workingTreeEntries.length,
      fromUntracked: profile ? getUntrackedSourceEntries({ repoRoot, profile, fileExtensions }).length : 0,
    },
  };
};

const readChangeContents = ({ repoRoot, entry, baseRef }) => {
  const basePath = entry?.status === 'R' ? entry.oldPath : entry?.oldPath;
  const headPath = entry?.status === 'R' ? entry.newPath : entry?.newPath;

  const baseContent = basePath ? readFileFromBaseRef({ repoRoot, relativePath: basePath, baseRef }) : null;
  const headContent = headPath ? readFileFromWorkingTree({ repoRoot, relativePath: headPath }) : null;

  return { basePath: basePath || null, headPath: headPath || null, baseContent, headContent };
};

module.exports = {
  SUPPORTED_FILE_EXTENSIONS,
  listFilesRecursive,
  getChangedEntries,
  readChangeContents,
  getUntrackedSpecPaths,
  getUntrackedSourceEntries,
  __testOnly: {
    parseChangedEntryLine,
    normalizeEntryStatus,
    mergeByPriority,
  },
};
