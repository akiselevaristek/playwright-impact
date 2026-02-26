'use strict';

const fs = require('fs');
const ts = require('typescript');

const DEFAULT_SELECTION_BIAS = 'fail-open';
const MAX_PRECISE_CHAIN_DEPTH = 2;

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

const extractFixtureVariablesFromSpecAst = ({ sourceFile, fixtureKeyToClass, fixtureKeys }) => {
  // Map fixture variable names used in test callbacks to their underlying POM class.
  const fixtureVarToClass = new Map();

  const parseBindingPattern = (bindingPattern) => {
    for (const element of bindingPattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      const fixtureKey = getFixtureKeyFromBindingElement(element);
      if (!fixtureKey) continue;
      if (!fixtureKeys.has(fixtureKey)) continue;

      const className = fixtureKeyToClass.get(fixtureKey);
      if (!className) continue;

      if (ts.isIdentifier(element.name)) {
        fixtureVarToClass.set(element.name.text, className);
        continue;
      }

      if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        fixtureVarToClass.set(fixtureKey, className);
      }
    }
  };

  const visit = (node) => {
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.parameters.length > 0) {
      for (const parameter of node.parameters) {
        if (ts.isObjectBindingPattern(parameter.name)) parseBindingPattern(parameter.name);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return fixtureVarToClass;
};

const getLiteralNameFromArgumentExpression = (node) => {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
};

const getRootIdentifierName = (node) => {
  let current = node;
  while (current) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    return null;
  }
  return null;
};

const getAccessChainDepth = (node) => {
  let depth = 0;
  let current = node;
  while (current && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))) {
    depth += 1;
    current = current.expression;
  }
  return depth;
};

/**
 * Stage B matcher for a single spec AST.
 * Produces:
 * - precise matches for known fixtureVar.method() patterns
 * - uncertain call-site count for dynamic/alias/deep patterns
 */
const collectImpactedMethodMatchesInSpec = ({ sourceFile, fixtureVarToClass, impactedMethodsByClass, selectionBias }) => {
  // Stage B checks fixtureVar.method(), fixtureVar[method](), and optional call-chain forms.
  const preciseMatches = new Set();
  let uncertainCallSites = 0;
  const aliasCalls = new Map();

  const includeUncertain = selectionBias === 'fail-open';

  const tryRegisterAlias = (aliasName, className, methodName, isUncertain) => {
    if (!aliasName || !className) return;
    aliasCalls.set(aliasName, {
      className,
      methodName: methodName || null,
      isUncertain: Boolean(isUncertain || !methodName),
    });
  };

  const visit = (node) => {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isPropertyAccessExpression(node.initializer) || ts.isElementAccessExpression(node.initializer)) {
          const rootIdentifier = getRootIdentifierName(node.initializer.expression);
          const className = rootIdentifier ? fixtureVarToClass.get(rootIdentifier) : null;
          if (className) {
            const methodName = ts.isPropertyAccessExpression(node.initializer)
              ? (ts.isIdentifier(node.initializer.name) ? node.initializer.name.text : null)
              : getLiteralNameFromArgumentExpression(node.initializer.argumentExpression);
            const uncertain = true;
            tryRegisterAlias(node.name.text, className, methodName, uncertain);
          }
        }
      }

      if (ts.isObjectBindingPattern(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
        const className = fixtureVarToClass.get(node.initializer.text);
        if (className) {
          for (const element of node.name.elements) {
            if (!ts.isBindingElement(element)) continue;
            const methodName = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : (ts.isIdentifier(element.name) ? element.name.text : null);
            const aliasName = ts.isIdentifier(element.name) ? element.name.text : null;
            tryRegisterAlias(aliasName, className, methodName, true);
          }
        }
      }
    }

    const isCallLike = ts.isCallExpression(node) || (typeof ts.isCallChain === 'function' && ts.isCallChain(node));
    if (isCallLike && ts.isIdentifier(node.expression)) {
      const alias = aliasCalls.get(node.expression.text);
      if (alias) {
        const impactedMethods = impactedMethodsByClass.get(alias.className) || new Set();
        if (alias.methodName && impactedMethods.has(alias.methodName) && !alias.isUncertain) {
          preciseMatches.add(`${alias.className}.${alias.methodName}`);
        } else {
          uncertainCallSites += 1;
        }
      }
    }

    if (isCallLike && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const calleeExpression = node.expression;
      const objectExpr = calleeExpression.expression;
      const rootIdentifier = getRootIdentifierName(objectExpr);
      const className = rootIdentifier ? fixtureVarToClass.get(rootIdentifier) : null;

      if (className) {
        const impactedMethods = impactedMethodsByClass.get(className) || new Set();
        const chainDepth = getAccessChainDepth(objectExpr);
        const tooDeepForPrecise = chainDepth > MAX_PRECISE_CHAIN_DEPTH;

        if (ts.isPropertyAccessExpression(calleeExpression) && ts.isIdentifier(calleeExpression.name)) {
          const methodName = calleeExpression.name.text;
          if (tooDeepForPrecise) {
            // Deep chains are intentionally uncertain to avoid false-precise matches.
            uncertainCallSites += 1;
          } else if (impactedMethods.has(methodName)) {
            preciseMatches.add(`${className}.${methodName}`);
          }
        }

        if (ts.isElementAccessExpression(calleeExpression)) {
          const methodName = getLiteralNameFromArgumentExpression(calleeExpression.argumentExpression);
          if (methodName) {
            if (tooDeepForPrecise) {
              uncertainCallSites += 1;
            } else if (impactedMethods.has(methodName)) {
              preciseMatches.add(`${className}.${methodName}`);
            }
          } else {
            uncertainCallSites += 1;
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    preciseMatches: Array.from(preciseMatches).sort((a, b) => a.localeCompare(b)),
    uncertainCallSites,
    shouldIncludeByUncertain: includeUncertain && uncertainCallSites > 0,
  };
};

/**
 * Final Stage B spec filter.
 * Policy:
 * - direct changed specs are always retained
 * - precise matches are retained
 * - uncertain-only specs are retained only in fail-open mode
 */
const filterSpecsByImpactedMethods = ({
  selectedSpecs,
  directChangedSpecsAbs,
  alwaysIncludeSpecsAbs = [],
  fixtureKeyToClass,
  fixtureKeys,
  impactedMethodsByClass,
  selectionBias = DEFAULT_SELECTION_BIAS,
}) => {
  // Stage B keeps direct changed specs unconditionally and filters the rest by impacted calls.
  if (selectedSpecs.length === 0) {
    return {
      filteredSpecs: [],
      droppedByMethodFilter: 0,
      retainedWithoutMethodFilter: 0,
      selectionReasons: new Map(),
      uncertainCallSites: 0,
      warnings: [],
    };
  }

  const directChangedSet = new Set(directChangedSpecsAbs);
  const alwaysIncludeSet = new Set(alwaysIncludeSpecsAbs);
  const selectionReasons = new Map();
  const warnings = [];
  let uncertainCallSitesTotal = 0;

  if (impactedMethodsByClass.size === 0) {
    let retainedWithoutMethodFilter = 0;
    for (const specPath of selectedSpecs) {
      if (directChangedSet.has(specPath)) {
        selectionReasons.set(specPath, 'direct-changed-spec');
      } else if (alwaysIncludeSet.has(specPath)) {
        selectionReasons.set(specPath, 'matched-import-graph');
      } else {
        retainedWithoutMethodFilter += 1;
        selectionReasons.set(specPath, 'retained-no-impacted-methods');
      }
    }
    return {
      filteredSpecs: selectedSpecs,
      droppedByMethodFilter: 0,
      retainedWithoutMethodFilter,
      selectionReasons,
      uncertainCallSites: 0,
      warnings,
    };
  }

  const filteredSpecs = [];
  let droppedByMethodFilter = 0;
  let retainedWithoutMethodFilter = 0;

  for (const specPath of selectedSpecs) {
    if (directChangedSet.has(specPath)) {
      filteredSpecs.push(specPath);
      selectionReasons.set(specPath, 'direct-changed-spec');
      continue;
    }
    if (alwaysIncludeSet.has(specPath)) {
      filteredSpecs.push(specPath);
      selectionReasons.set(specPath, 'matched-import-graph');
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(specPath, 'utf8');
    } catch (_error) {
      retainedWithoutMethodFilter += 1;
      filteredSpecs.push(specPath);
      selectionReasons.set(specPath, 'retained-read-error');
      continue;
    }

    const scriptKind = specPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(specPath, content, ts.ScriptTarget.Latest, true, scriptKind);
    const fixtureVarToClass = extractFixtureVariablesFromSpecAst({ sourceFile, fixtureKeyToClass, fixtureKeys });

    if (fixtureVarToClass.size === 0) {
      retainedWithoutMethodFilter += 1;
      filteredSpecs.push(specPath);
      selectionReasons.set(specPath, 'retained-no-bindings');
      continue;
    }

    const matchResult = collectImpactedMethodMatchesInSpec({
      sourceFile,
      fixtureVarToClass,
      impactedMethodsByClass,
      selectionBias,
    });
    uncertainCallSitesTotal += matchResult.uncertainCallSites;

    if (matchResult.preciseMatches.length > 0) {
      filteredSpecs.push(specPath);
      selectionReasons.set(specPath, 'matched-precise');
      continue;
    }

    if (matchResult.shouldIncludeByUncertain) {
      filteredSpecs.push(specPath);
      selectionReasons.set(specPath, 'matched-uncertain-fail-open');
      warnings.push(`Uncertain callsite retained spec: ${specPath}`);
      continue;
    }

    droppedByMethodFilter += 1;
  }

  return {
    filteredSpecs: filteredSpecs.sort((a, b) => a.localeCompare(b)),
    droppedByMethodFilter,
    retainedWithoutMethodFilter,
    selectionReasons,
    uncertainCallSites: uncertainCallSitesTotal,
    warnings,
  };
};

module.exports = {
  filterSpecsByImpactedMethods,
};
