'use strict';

const fs = require('fs');
const ts = require('typescript');

const DEFAULT_EXTENSIONS = ['.ts', '.tsx'];

const getFixtureKeyFromBindingElement = (element) => {
  if (!ts.isBindingElement(element)) return null;

  if (element.propertyName) {
    if (ts.isIdentifier(element.propertyName)) return element.propertyName.text;
    if (ts.isStringLiteral(element.propertyName) || ts.isNoSubstitutionTemplateLiteral(element.propertyName)) {
      return element.propertyName.text;
    }
  }

  if (ts.isIdentifier(element.name)) return element.name.text;
  return null;
};

/**
 * Stage A fixture extraction from spec callback parameters.
 * Supports destructuring, aliasing, defaults, and TS syntax.
 */
const extractFixtureUsagesFromSpec = (content, filePath) => {
  const used = new Set();
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);

  const collectFromBindingPattern = (pattern) => {
    for (const element of pattern.elements) {
      const fixtureKey = getFixtureKeyFromBindingElement(element);
      if (fixtureKey) used.add(fixtureKey);
    }
  };

  const visit = (node) => {
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.parameters?.length > 0) {
      for (const parameter of node.parameters) {
        if (ts.isObjectBindingPattern(parameter.name)) collectFromBindingPattern(parameter.name);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return used;
};

/**
 * Stage A spec prefilter:
 * select only spec files that bind at least one impacted fixture key.
 */
const selectSpecFiles = ({ testsRootAbs, fixtureKeys, listFilesRecursive, fileExtensions = DEFAULT_EXTENSIONS }) => {
  const specFiles = listFilesRecursive(testsRootAbs)
    .filter((filePath) => fileExtensions.some((ext) => filePath.endsWith(`.spec${ext}`)));
  const selected = [];

  for (const filePath of specFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const usedKeys = extractFixtureUsagesFromSpec(content, filePath);
    const isImpacted = Array.from(fixtureKeys).some((key) => usedKeys.has(key));
    if (isImpacted) selected.push(filePath);
  }

  return selected.sort((a, b) => a.localeCompare(b));
};

module.exports = {
  selectSpecFiles,
  extractFixtureUsagesFromSpec,
};
