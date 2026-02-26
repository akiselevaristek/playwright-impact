'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const DEFAULT_GLOBAL_WATCH_PATTERNS = [
  'playwright.stem.config.ts',
  'playwright.mn.config.ts',
  'playwright.e2e.config.ts',
  'src/global-setup.ts',
  'src/global-setup-stem.ts',
  'src/global-setup-mn.ts',
  'src/fixtures/**',
  'src/setup/**',
  'src/config/config.ts',
  'src/config/urls.ts',
  'src/reporters/**',
  'src/scripts/verify-*.js',
  'src/api/mocks/**',
];

const WATCH_DEP_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml'];

const normalizePath = (filePath) => String(filePath || '').replace(/\\/g, '/');

const globToRegex = (globPattern) => {
  const normalized = normalizePath(globPattern).replace(/^\.\//, '');
  let regex = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      regex += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      regex += '[^/]*';
      continue;
    }
    if ('\\^$+?.()|{}[]'.includes(char)) {
      regex += `\\${char}`;
      continue;
    }
    regex += char;
  }
  regex += '$';
  return new RegExp(regex);
};

const getDefaultGlobalWatchPatterns = () => [...DEFAULT_GLOBAL_WATCH_PATTERNS];

const getCandidateFilePaths = (basePath) => {
  const ext = path.extname(basePath).toLowerCase();
  if (WATCH_DEP_EXTENSIONS.includes(ext)) return [basePath];

  const candidates = [];
  candidates.push(...WATCH_DEP_EXTENSIONS.map((fileExt) => `${basePath}${fileExt}`));
  candidates.push(...WATCH_DEP_EXTENSIONS.map((fileExt) => path.join(basePath, `index${fileExt}`)));
  return candidates;
};

const readTsConfigPathAliases = (repoRoot) => {
  const tsConfigPath = path.join(repoRoot, 'tsconfig.json');
  if (!fs.existsSync(tsConfigPath)) return [];

  const rawText = fs.readFileSync(tsConfigPath, 'utf8');
  const parsedResult = ts.parseConfigFileTextToJson(tsConfigPath, rawText);
  const parsed = parsedResult?.config;
  if (!parsed || typeof parsed !== 'object') return [];

  const baseUrl = parsed?.compilerOptions?.baseUrl || '.';
  const paths = parsed?.compilerOptions?.paths || {};
  const entries = [];

  for (const [aliasPattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.length === 0) continue;
    const hasWildcard = aliasPattern.includes('*');
    const [aliasPrefix, aliasSuffix] = hasWildcard ? aliasPattern.split('*') : [aliasPattern, ''];

    entries.push({
      aliasPattern,
      aliasPrefix,
      aliasSuffix,
      hasWildcard,
      targets: targets.map((targetPattern) => {
        const [targetPrefix, targetSuffix] = targetPattern.includes('*') ? targetPattern.split('*') : [targetPattern, ''];
        return { targetPrefix, targetSuffix };
      }),
      baseUrlAbs: path.resolve(repoRoot, baseUrl),
    });
  }

  return entries;
};

const resolveModuleSpecifier = ({ importerAbsPath, moduleSpecifier, repoRoot, aliasEntries }) => {
  const resolved = [];

  const addResolvedFromBase = (basePathAbs) => {
    for (const candidate of getCandidateFilePaths(basePathAbs)) {
      if (!fs.existsSync(candidate)) continue;
      resolved.push(path.resolve(candidate));
    }
  };

  if (moduleSpecifier.startsWith('.')) {
    addResolvedFromBase(path.resolve(path.dirname(importerAbsPath), moduleSpecifier));
    return Array.from(new Set(resolved));
  }

  const looksLikeFileName = /\.[A-Za-z0-9]+$/.test(moduleSpecifier);
  if (looksLikeFileName) {
    let currentDir = path.dirname(importerAbsPath);
    const repoRootAbs = path.resolve(repoRoot);
    while (currentDir.startsWith(repoRootAbs)) {
      const candidate = path.resolve(currentDir, moduleSpecifier);
      if (fs.existsSync(candidate)) resolved.push(candidate);
      if (currentDir === repoRootAbs) break;
      currentDir = path.dirname(currentDir);
    }
  }

  for (const alias of aliasEntries) {
    if (!alias.hasWildcard) {
      if (moduleSpecifier !== alias.aliasPattern) continue;
      for (const target of alias.targets) addResolvedFromBase(path.resolve(alias.baseUrlAbs, target.targetPrefix));
      continue;
    }

    if (!moduleSpecifier.startsWith(alias.aliasPrefix) || !moduleSpecifier.endsWith(alias.aliasSuffix)) continue;
    const wildcardValue = moduleSpecifier.slice(alias.aliasPrefix.length, moduleSpecifier.length - alias.aliasSuffix.length);
    for (const target of alias.targets) {
      const joined = `${target.targetPrefix}${wildcardValue}${target.targetSuffix}`;
      addResolvedFromBase(path.resolve(alias.baseUrlAbs, joined));
    }
  }

  return Array.from(new Set(resolved));
};

const extractImportSpecifiers = (sourceFile) => {
  const specifiers = [];
  const addText = (node) => {
    if (node && ts.isStringLiteral(node)) specifiers.push(node.text);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) addText(node.moduleSpecifier);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) addText(node.moduleSpecifier);
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') addText(node.arguments?.[0]);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addText(node.arguments?.[0]);
      for (const argument of node.arguments || []) {
        if (ts.isStringLiteral(argument) && /\.[A-Za-z0-9]+$/.test(argument.text)) specifiers.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
};

const resolveWatchSeedFiles = ({ repoRoot, patterns, listFilesRecursive }) => {
  const seedFiles = new Set();
  for (const pattern of patterns) {
    const normalizedPattern = normalizePath(pattern).replace(/^\.\//, '');
    const hasWildcard = normalizedPattern.includes('*');
    const absolute = path.resolve(repoRoot, normalizedPattern);
    if (!hasWildcard) {
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) seedFiles.add(absolute);
      continue;
    }

    const regex = globToRegex(normalizedPattern);
    const firstWildcardIndex = normalizedPattern.indexOf('*');
    const fixedPrefix = firstWildcardIndex >= 0 ? normalizedPattern.slice(0, firstWildcardIndex) : normalizedPattern;
    const prefixDir = fixedPrefix.includes('/') ? fixedPrefix.slice(0, fixedPrefix.lastIndexOf('/')) : '';
    const scanRoot = path.resolve(repoRoot, prefixDir || '.');
    if (!fs.existsSync(scanRoot)) continue;

    const candidates = fs.statSync(scanRoot).isFile() ? [scanRoot] : listFilesRecursive(scanRoot);
    for (const candidateAbs of candidates) {
      if (!fs.existsSync(candidateAbs) || !fs.statSync(candidateAbs).isFile()) continue;
      const relative = normalizePath(path.relative(repoRoot, candidateAbs));
      if (regex.test(relative)) seedFiles.add(path.resolve(candidateAbs));
    }
  }
  return seedFiles;
};

const resolveGlobalWatchClosure = ({ repoRoot, patterns, listFilesRecursive }) => {
  const aliasEntries = readTsConfigPathAliases(repoRoot);
  const seeds = resolveWatchSeedFiles({ repoRoot, patterns, listFilesRecursive });
  const resolvedFiles = new Set(seeds);
  const queue = Array.from(seeds);
  const visited = new Set();

  while (queue.length > 0) {
    const currentAbs = path.resolve(queue.shift());
    if (visited.has(currentAbs)) continue;
    visited.add(currentAbs);
    if (!fs.existsSync(currentAbs)) continue;

    const ext = path.extname(currentAbs).toLowerCase();
    if (!WATCH_DEP_EXTENSIONS.includes(ext) || ext === '.json' || ext === '.yml' || ext === '.yaml') continue;

    let content;
    try {
      content = fs.readFileSync(currentAbs, 'utf8');
    } catch (_error) {
      continue;
    }

    const scriptKind = currentAbs.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : (currentAbs.endsWith('.js') || currentAbs.endsWith('.mjs') || currentAbs.endsWith('.cjs'))
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

    const sourceFile = ts.createSourceFile(currentAbs, content, ts.ScriptTarget.Latest, true, scriptKind);
    const importSpecifiers = extractImportSpecifiers(sourceFile);
    for (const moduleSpecifier of importSpecifiers) {
      const dependencies = resolveModuleSpecifier({ importerAbsPath: currentAbs, moduleSpecifier, repoRoot, aliasEntries });
      for (const dependencyAbs of dependencies) {
        if (!dependencyAbs.startsWith(path.resolve(repoRoot))) continue;
        if (!resolvedFiles.has(dependencyAbs)) {
          resolvedFiles.add(dependencyAbs);
          queue.push(dependencyAbs);
        }
      }
    }
  }

  return {
    resolvedFilesAbs: resolvedFiles,
    resolvedFilesRelative: Array.from(resolvedFiles).map((filePath) => normalizePath(path.relative(repoRoot, filePath))).sort((a, b) => a.localeCompare(b)),
  };
};

const evaluateGlobalWatch = ({
  repoRoot,
  changedEntries,
  patterns,
  listFilesRecursive,
}) => {
  const effectivePatterns = Array.isArray(patterns) && patterns.length > 0 ? patterns : getDefaultGlobalWatchPatterns();
  const patternRegexes = effectivePatterns.map((pattern) => globToRegex(normalizePath(pattern).replace(/^\.\//, '')));
  const closure = resolveGlobalWatchClosure({ repoRoot, patterns: effectivePatterns, listFilesRecursive });
  const matched = new Set();

  for (const entry of changedEntries) {
    for (const candidate of [entry.effectivePath, entry.oldPath, entry.newPath]) {
      if (!candidate) continue;
      const relative = normalizePath(candidate).replace(/^\.\//, '');
      const absolute = path.resolve(repoRoot, relative);
      const byPattern = patternRegexes.some((regex) => regex.test(relative));
      const byClosure = closure.resolvedFilesAbs.has(absolute);
      if (byPattern || byClosure) matched.add(relative);
    }
  }

  return {
    matchedPaths: Array.from(matched).sort((a, b) => a.localeCompare(b)),
    resolvedFiles: closure.resolvedFilesRelative,
  };
};

module.exports = {
  getDefaultGlobalWatchPatterns,
  evaluateGlobalWatch,
  __testOnly: {
    globToRegex,
    resolveGlobalWatchClosure,
  },
};
