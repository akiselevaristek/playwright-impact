'use strict';

const fs = require('fs');
const ts = require('typescript');

/**
 * Parse fixture declarations from fixture types file.
 * Supported shapes include direct types, namespace-qualified types,
 * interfaces, and type intersections.
 */
const parseFixtureClassMap = ({ typesPath }) => {
  if (!typesPath || !fs.existsSync(typesPath)) return new Map();
  const content = fs.readFileSync(typesPath, 'utf8');
  const classToFixtureKeys = new Map();
  const sourceFile = ts.createSourceFile(typesPath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarationsByName = new Map();
  const memoByDeclarationName = new Map();

  const addMapping = (fixtureKey, className) => {
    if (!fixtureKey || !className) return;
    if (!classToFixtureKeys.has(className)) classToFixtureKeys.set(className, new Set());
    classToFixtureKeys.get(className).add(fixtureKey);
  };

  const getDeclarationName = (node) => {
    if (!node || !node.name || !ts.isIdentifier(node.name)) return null;
    return node.name.text;
  };

  const getEntityRightmostName = (entity) => {
    if (!entity) return null;
    if (ts.isIdentifier(entity)) return entity.text;
    if (ts.isQualifiedName(entity)) return entity.right.text;
    return null;
  };

  const getExpressionRightmostName = (expression) => {
    if (!expression) return null;
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return null;
  };

  const getPropertyNameText = (nameNode) => {
    if (!nameNode) return null;
    if (ts.isIdentifier(nameNode)) return nameNode.text;
    if (ts.isStringLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode)) return nameNode.text;
    return null;
  };

  const getTypeReferenceName = (typeNode) => {
    if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return null;
    return getEntityRightmostName(typeNode.typeName);
  };

  const isClassLikeTypeName = (typeName) => Boolean(typeName) && /^[A-Z]/.test(typeName);

  const collectPairsFromTypeNode = (typeNode, visitingNames) => {
    if (!typeNode) return [];

    if (ts.isTypeLiteralNode(typeNode)) {
      const pairs = [];
      for (const member of typeNode.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue;
        const fixtureKey = getPropertyNameText(member.name);
        const className = getTypeReferenceName(member.type);
        if (fixtureKey && isClassLikeTypeName(className)) {
          pairs.push([fixtureKey, className]);
        }
      }
      return pairs;
    }

    if (ts.isIntersectionTypeNode(typeNode) || ts.isUnionTypeNode(typeNode)) {
      return typeNode.types.flatMap((child) => collectPairsFromTypeNode(child, visitingNames));
    }

    if (ts.isParenthesizedTypeNode(typeNode)) {
      return collectPairsFromTypeNode(typeNode.type, visitingNames);
    }

    if (ts.isTypeReferenceNode(typeNode)) {
      const refName = getEntityRightmostName(typeNode.typeName);
      if (!refName) return [];
      return collectPairsFromDeclarationName(refName, visitingNames);
    }

    return [];
  };

  const collectPairsFromInterface = (declaration, visitingNames) => {
    const pairs = [];
    for (const member of declaration.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      const fixtureKey = getPropertyNameText(member.name);
      const className = getTypeReferenceName(member.type);
      if (fixtureKey && isClassLikeTypeName(className)) pairs.push([fixtureKey, className]);
      if (member.type) pairs.push(...collectPairsFromTypeNode(member.type, visitingNames));
    }

    for (const heritageClause of declaration.heritageClauses || []) {
      if (heritageClause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const heritageType of heritageClause.types) {
        const baseName = getExpressionRightmostName(heritageType.expression);
        if (!baseName) continue;
        pairs.push(...collectPairsFromDeclarationName(baseName, visitingNames));
      }
    }

    return pairs;
  };

  const collectPairsFromDeclarationName = (declarationName, visitingNames) => {
    if (!declarationName) return [];
    if (memoByDeclarationName.has(declarationName)) return memoByDeclarationName.get(declarationName);
    if (visitingNames.has(declarationName)) return [];

    visitingNames.add(declarationName);
    const declaration = declarationsByName.get(declarationName);
    if (!declaration) {
      visitingNames.delete(declarationName);
      memoByDeclarationName.set(declarationName, []);
      return [];
    }

    let pairs = [];
    if (ts.isTypeAliasDeclaration(declaration)) {
      pairs = collectPairsFromTypeNode(declaration.type, visitingNames);
    } else if (ts.isInterfaceDeclaration(declaration)) {
      pairs = collectPairsFromInterface(declaration, visitingNames);
    }

    visitingNames.delete(declarationName);
    memoByDeclarationName.set(declarationName, pairs);
    return pairs;
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) continue;
    const declarationName = getDeclarationName(statement);
    if (!declarationName) continue;
    declarationsByName.set(declarationName, statement);
  }

  for (const declarationName of declarationsByName.keys()) {
    const pairs = collectPairsFromDeclarationName(declarationName, new Set());
    for (const [fixtureKey, className] of pairs) addMapping(fixtureKey, className);
  }

  return classToFixtureKeys;
};

/**
 * Return bidirectional fixture mappings used by Stage A and Stage B.
 */
const parseFixtureMappings = ({ typesPath }) => {
  const classToFixtureKeys = parseFixtureClassMap({ typesPath });
  const fixtureKeyToClass = new Map();
  for (const [className, fixtureKeys] of classToFixtureKeys.entries()) {
    for (const fixtureKey of fixtureKeys) fixtureKeyToClass.set(fixtureKey, className);
  }
  return { classToFixtureKeys, fixtureKeyToClass };
};

module.exports = {
  parseFixtureMappings,
};
