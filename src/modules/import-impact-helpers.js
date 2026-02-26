'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const DEFAULT_EXTENSIONS = ['.ts', '.tsx'];

const normalizePath = (filePath) => filePath.split(path.sep).join('/');

const toAbsolute = (repoRoot, relativePath) => path.resolve(repoRoot, normalizePath(relativePath));

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
        const [targetPrefix, targetSuffix] = targetPattern.includes('*')
          ? targetPattern.split('*')
          : [targetPattern, ''];
        return { targetPrefix, targetSuffix };
      }),
      baseUrlAbs: path.resolve(repoRoot, baseUrl),
    });
  }

  return entries;
};

const getCandidateFilePaths = (basePath, fileExtensions) => {
  const ext = path.extname(basePath).toLowerCase();
  if (fileExtensions.includes(ext)) return [basePath];

  const candidates = [];
  candidates.push(...fileExtensions.map((fileExt) => `${basePath}${fileExt}`));
  candidates.push(...fileExtensions.map((fileExt) => path.join(basePath, `index${fileExt}`)));
  return candidates;
};

const resolveModuleSpecifier = ({ importerAbsPath, moduleSpecifier, repoRoot, fileExtensions, aliasEntries }) => {
  const resolved = [];

  const addResolvedFromBase = (basePathAbs) => {
    for (const candidate of getCandidateFilePaths(basePathAbs, fileExtensions)) {
      if (!fs.existsSync(candidate)) continue;
      resolved.push(path.resolve(candidate));
    }
  };

  if (moduleSpecifier.startsWith('.')) {
    const importerDir = path.dirname(importerAbsPath);
    addResolvedFromBase(path.resolve(importerDir, moduleSpecifier));
    return Array.from(new Set(resolved));
  }

  // Support asset-like references passed as plain strings inside helpers,
  // for example: "getAcademicPeriods.completed.json".
  const looksLikeFileName = /\.[A-Za-z0-9]+$/.test(moduleSpecifier);
  if (looksLikeFileName) {
    // Resolve "file.ext" literals from current and parent directories.
    // This supports helpers that reference shared mock assets from parent folders.
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
      for (const target of alias.targets) {
        addResolvedFromBase(path.resolve(alias.baseUrlAbs, target.targetPrefix));
      }
      continue;
    }

    const startsOk = moduleSpecifier.startsWith(alias.aliasPrefix);
    const endsOk = moduleSpecifier.endsWith(alias.aliasSuffix);
    if (!startsOk || !endsOk) continue;

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
    if (!node || !ts.isStringLiteral(node)) return;
    specifiers.push(node.text);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) addText(node.moduleSpecifier);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) addText(node.moduleSpecifier);

    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        addText(node.arguments?.[0]);
      }

      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addText(node.arguments?.[0]);
      }

      for (const argument of node.arguments || []) {
        if (!ts.isStringLiteral(argument)) continue;
        if (!/\.[A-Za-z0-9]+$/.test(argument.text)) continue;
        specifiers.push(argument.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
};

const isSpecPath = (filePath, fileExtensions) => fileExtensions.some((ext) => filePath.endsWith(`.spec${ext}`));

/**
 * Select specs impacted by changed source imports/re-exports.
 * This stage covers helper/function modules that are not represented as fixture classes.
 */
const selectSpecsByChangedImports = ({
  repoRoot,
  testsRootAbs,
  changedPomEntries,
  listFilesRecursive,
  fileExtensions = DEFAULT_EXTENSIONS,
}) => {
  const aliasEntries = readTsConfigPathAliases(repoRoot);
  const specFiles = listFilesRecursive(testsRootAbs).filter((filePath) => isSpecPath(filePath, fileExtensions));

  const reverseDeps = new Map();
  const visited = new Set();
  const queue = [...specFiles];

  const addReverseEdge = (dependencyAbs, importerAbs) => {
    if (!reverseDeps.has(dependencyAbs)) reverseDeps.set(dependencyAbs, new Set());
    reverseDeps.get(dependencyAbs).add(importerAbs);
  };

  while (queue.length > 0) {
    const currentAbs = path.resolve(queue.shift());
    if (visited.has(currentAbs)) continue;
    visited.add(currentAbs);
    if (!fs.existsSync(currentAbs)) continue;

    let content;
    try {
      content = fs.readFileSync(currentAbs, 'utf8');
    } catch (_error) {
      continue;
    }

    const scriptKind = currentAbs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(currentAbs, content, ts.ScriptTarget.Latest, true, scriptKind);
    const importSpecifiers = extractImportSpecifiers(sourceFile);
    for (const moduleSpecifier of importSpecifiers) {
      const dependencies = resolveModuleSpecifier({
        importerAbsPath: currentAbs,
        moduleSpecifier,
        repoRoot,
        fileExtensions,
        aliasEntries,
      });

      for (const dependencyAbs of dependencies) {
        if (!dependencyAbs.startsWith(path.resolve(repoRoot))) continue;
        addReverseEdge(dependencyAbs, currentAbs);
        if (isSpecPath(dependencyAbs, fileExtensions)) continue;
        queue.push(dependencyAbs);
      }
    }
  }

  const changedSeeds = new Set();
  for (const entry of changedPomEntries) {
    for (const candidate of [entry.effectivePath, entry.oldPath, entry.newPath]) {
      if (!candidate) continue;
      changedSeeds.add(toAbsolute(repoRoot, candidate));
    }
  }

  const impactedSpecs = new Set();
  const traverseQueue = Array.from(changedSeeds);
  const traversed = new Set();
  while (traverseQueue.length > 0) {
    const current = traverseQueue.shift();
    if (traversed.has(current)) continue;
    traversed.add(current);

    const importers = reverseDeps.get(current) || new Set();
    for (const importerAbs of importers) {
      if (isSpecPath(importerAbs, fileExtensions)) impactedSpecs.add(importerAbs);
      if (!traversed.has(importerAbs)) traverseQueue.push(importerAbs);
    }
  }

  return Array.from(impactedSpecs).sort((a, b) => a.localeCompare(b));
};

module.exports = {
  selectSpecsByChangedImports,
};
