'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const createEmptyStats = () => ({
  changedPomEntriesByStatus: { A: 0, M: 0, D: 0, R: 0 },
  semanticChangedMethodsCount: 0,
  topLevelRuntimeChangedFiles: 0,
  impactedMethodsTotal: 0,
});

const simpleHash = (text) => {
  let hash = 2166136261;
  const value = String(text || '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16);
};

const normalizeText = (text) => String(text || '').replace(/\s+/g, ' ').trim();

const createSemanticCache = () => ({
  // AST and node-fingerprint caches are scoped to one script run.
  // They avoid repeated parse/print work for large POM sets.
  astByFileRef: new Map(),
  fingerprintByNode: new Map(),
  printer: ts.createPrinter({ removeComments: true }),
});

const getFingerprintForNode = ({ refKind, absPath, node, fingerprintKind, sourceFile, cache }) => {
  // Fingerprints are normalized to ignore formatting-only changes.
  const key = `${refKind}:${absPath}:${node.pos}:${node.end}:${fingerprintKind}`;
  if (cache.fingerprintByNode.has(key)) return cache.fingerprintByNode.get(key);

  const printed = cache.printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
  const normalized = normalizeText(printed);
  cache.fingerprintByNode.set(key, normalized);
  return normalized;
};

const isCallableProperty = (member) => {
  if (!ts.isPropertyDeclaration(member) || !member.initializer) return false;
  return ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer);
};

const getConstructorIdentity = (member) => {
  if (!ts.isConstructorDeclaration(member)) return null;
  return { type: 'ctor', name: 'constructor' };
};

const getMemberName = (member) => {
  if (!member || !member.name) return null;
  if (ts.isIdentifier(member.name)) return member.name.text;
  if (ts.isStringLiteral(member.name) || ts.isNoSubstitutionTemplateLiteral(member.name)) return member.name.text;
  return null;
};

const getTypeNameFromEntity = (entityName) => {
  if (!entityName) return null;
  if (ts.isIdentifier(entityName)) return entityName.text;
  if (ts.isQualifiedName(entityName)) return entityName.right.text;
  return null;
};

const getTypeReferenceName = (typeNode) => {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return null;
  return getTypeNameFromEntity(typeNode.typeName);
};

const getFieldNameFromThisPropertyAccess = (node) => {
  if (!node) return null;
  if (ts.isPropertyAccessExpression(node)) {
    if (node.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
    if (!ts.isIdentifier(node.name)) return null;
    return node.name.text;
  }

  if (ts.isElementAccessExpression(node)) {
    if (node.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
    if (!node.argumentExpression) return null;
    if (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) {
      return node.argumentExpression.text;
    }
  }

  return null;
};

const getLiteralNameFromArgumentExpression = (node) => {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
};

const collectComposedFieldMappingsFromConstructor = (constructorNode) => {
  const mappings = new Map();
  if (!constructorNode || !constructorNode.body) return mappings;

  for (const statement of constructorNode.body.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const expression = statement.expression;
    if (!ts.isBinaryExpression(expression)) continue;
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;

    const fieldName = getFieldNameFromThisPropertyAccess(expression.left);
    if (!fieldName) continue;
    if (!ts.isNewExpression(expression.right)) continue;

    const className = getTypeNameFromEntity(expression.right.expression);
    if (!className) continue;
    mappings.set(fieldName, className);
  }

  return mappings;
};

const getMemberIdentity = (member) => {
  const ctor = getConstructorIdentity(member);
  if (ctor) return ctor;

  const name = getMemberName(member);
  if (!name) return null;
  if (ts.isGetAccessorDeclaration(member)) return { type: 'get', name };
  if (ts.isSetAccessorDeclaration(member)) return { type: 'set', name };
  if (ts.isPropertyDeclaration(member) && !isCallableProperty(member)) return { type: 'field', name };
  return { type: 'call', name };
};

const isRuntimeStatement = (statement) => {
  // Class body changes are handled by semantic member diff below.
  // Keeping class declarations here causes single-method edits to look like top-level runtime changes.
  if (ts.isClassDeclaration(statement)) return false;
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return false;
  if (ts.isImportDeclaration(statement)) {
    return !statement.importClause || !statement.importClause.isTypeOnly;
  }
  if (ts.isExportDeclaration(statement)) return !statement.isTypeOnly;
  return true;
};

const parseFileModel = ({ refKind, absPath, content, cache }) => {
  // Parse once per unique file/ref/content and keep a compact model for semantic diff.
  if (typeof content !== 'string') return null;

  const key = `${refKind}:${absPath}:${content.length}:${simpleHash(content)}`;
  if (cache.astByFileRef.has(key)) return cache.astByFileRef.get(key);

  const scriptKind = path.extname(absPath).toLowerCase() === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true, scriptKind);
  const runtimeStatements = sourceFile.statements.filter((statement) => isRuntimeStatement(statement));
  const classModels = new Map();

  const ensureClassModel = (className) => {
    if (classModels.has(className)) return classModels.get(className);
    const model = {
      membersByIdentity: new Map(),
      callableMembersByName: new Map(),
      composedFieldClassByName: new Map(),
    };
    classModels.set(className, model);
    return model;
  };

  const ensureMemberModel = ({ classModel, className, identity }) => {
    const keyForClass = `${identity.type}:${identity.name}`;
    if (classModel.membersByIdentity.has(keyForClass)) return classModel.membersByIdentity.get(keyForClass);

    const memberModel = {
      className,
      memberName: identity.name,
      identityType: identity.type,
      overloadNodes: [],
      implementationNode: null,
      callable: identity.type === 'call' || identity.type === 'ctor' || identity.type === 'get' || identity.type === 'set',
    };
    classModel.membersByIdentity.set(keyForClass, memberModel);
    if (memberModel.callable) {
      classModel.callableMembersByName.set(identity.name, memberModel);
    }
    return memberModel;
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name?.text) continue;
    const className = statement.name.text;
    const classModel = ensureClassModel(className);

    for (const member of statement.members) {
      const identity = getMemberIdentity(member);
      if (!identity) continue;

      const memberModel = ensureMemberModel({ classModel, className, identity });

      if (ts.isMethodDeclaration(member)) {
        if (member.body) memberModel.implementationNode = member;
        else memberModel.overloadNodes.push(member);
      } else if (ts.isConstructorDeclaration(member)) {
        memberModel.implementationNode = member;
        const ctorMappings = collectComposedFieldMappingsFromConstructor(member);
        for (const [fieldName, typeName] of ctorMappings.entries()) {
          classModel.composedFieldClassByName.set(fieldName, typeName);
        }
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        memberModel.implementationNode = member;
      } else if (isCallableProperty(member)) {
        memberModel.implementationNode = member;
      } else if (ts.isPropertyDeclaration(member)) {
        memberModel.implementationNode = member;
        const fieldName = getMemberName(member);
        const fieldTypeName = getTypeReferenceName(member.type);
        if (fieldName && fieldTypeName) {
          classModel.composedFieldClassByName.set(fieldName, fieldTypeName);
        }
      }
    }
  }

  const result = {
    sourceFile,
    runtimeStatements,
    classModels,
  };
  cache.astByFileRef.set(key, result);
  return result;
};

const getRuntimeFingerprint = ({ refKind, absPath, parsed, cache }) => {
  if (!parsed) return '';
  return parsed.runtimeStatements
    .map((statement) => getFingerprintForNode({
      refKind,
      absPath,
      node: statement,
      fingerprintKind: 'topLevelStatement',
      sourceFile: parsed.sourceFile,
      cache,
    }))
    .join('\n');
};

const getMemberFingerprint = ({ refKind, absPath, parsed, memberModel, cache }) => {
  // Overload signatures and implementation are combined to catch API-shape changes.
  if (!parsed || !memberModel) return '';
  const overloadFingerprint = memberModel.overloadNodes
    .map((node) => getFingerprintForNode({ refKind, absPath, node, fingerprintKind: 'memberSignature', sourceFile: parsed.sourceFile, cache }))
    .join('\n');

  const implementationFingerprint = memberModel.implementationNode
    ? getFingerprintForNode({
      refKind,
      absPath,
      node: memberModel.implementationNode,
      fingerprintKind: 'memberImplementation',
      sourceFile: parsed.sourceFile,
      cache,
    })
    : '';

  return `overloads:${overloadFingerprint}\nimplementation:${implementationFingerprint}`;
};

const addChangedMethod = (changedMethodsByClass, className, memberName) => {
  if (!className || !memberName) return;
  if (!changedMethodsByClass.has(className)) changedMethodsByClass.set(className, new Set());
  changedMethodsByClass.get(className).add(memberName);
};

const addAllCallableMembers = ({ parsed, changedMethodsByClass }) => {
  if (!parsed) return;
  for (const [className, classModel] of parsed.classModels.entries()) {
    for (const memberName of classModel.callableMembersByName.keys()) {
      addChangedMethod(changedMethodsByClass, className, memberName);
    }
  }
};

const addCallableMembersFromClassModel = ({ classModel, className, changedMethodsByClass }) => {
  if (!classModel) return;
  for (const memberName of classModel.callableMembersByName.keys()) {
    addChangedMethod(changedMethodsByClass, className, memberName);
  }
};

/**
 * Build semantic seed of changed callable members per class from changed source entries.
 * The seed intentionally ignores formatting-only edits and expands field-level changes to callables.
 */
const collectChangedMethodsByClass = ({ changedPomEntries, baseRef, readChangeContents }) => {
  // Semantic seed stage:
  // 1) compare top-level runtime statements
  // 2) compare class members (methods/accessors/ctor/callable properties/fields)
  // 3) convert changed non-callable fields into callable-method impact for the class
  const changedMethodsByClass = new Map();
  const stats = createEmptyStats();
  const cache = createSemanticCache();

  for (const entry of changedPomEntries) {
    if (stats.changedPomEntriesByStatus[entry.status] !== undefined) {
      stats.changedPomEntriesByStatus[entry.status] += 1;
    }

    const { basePath, headPath, baseContent, headContent } = readChangeContents(entry, baseRef);
    const baseAbsPath = basePath || entry.effectivePath;
    const headAbsPath = headPath || entry.effectivePath;

    if (baseContent !== null && headContent !== null && baseContent === headContent) {
      continue;
    }

    const parsedBase = parseFileModel({ refKind: 'base', absPath: baseAbsPath, content: baseContent, cache });
    const parsedHead = parseFileModel({ refKind: 'head', absPath: headAbsPath, content: headContent, cache });

    const baseRuntime = getRuntimeFingerprint({ refKind: 'base', absPath: baseAbsPath, parsed: parsedBase, cache });
    const headRuntime = getRuntimeFingerprint({ refKind: 'head', absPath: headAbsPath, parsed: parsedHead, cache });

    if (baseRuntime !== headRuntime) {
      stats.topLevelRuntimeChangedFiles += 1;
      addAllCallableMembers({ parsed: parsedBase, changedMethodsByClass });
      addAllCallableMembers({ parsed: parsedHead, changedMethodsByClass });
    }

    const classNames = new Set([
      ...Array.from(parsedBase?.classModels.keys() || []),
      ...Array.from(parsedHead?.classModels.keys() || []),
    ]);

    for (const className of classNames) {
      const baseClass = parsedBase?.classModels.get(className);
      const headClass = parsedHead?.classModels.get(className);
      const identities = new Set([
        ...Array.from(baseClass?.membersByIdentity.keys() || []),
        ...Array.from(headClass?.membersByIdentity.keys() || []),
      ]);

      for (const identity of identities) {
        const baseMember = baseClass?.membersByIdentity.get(identity) || null;
        const headMember = headClass?.membersByIdentity.get(identity) || null;

        const baseFingerprint = getMemberFingerprint({
          refKind: 'base',
          absPath: baseAbsPath,
          parsed: parsedBase,
          memberModel: baseMember,
          cache,
        });
        const headFingerprint = getMemberFingerprint({
          refKind: 'head',
          absPath: headAbsPath,
          parsed: parsedHead,
          memberModel: headMember,
          cache,
        });

        if (baseFingerprint === headFingerprint) continue;

        const targetClass = headMember?.className || baseMember?.className;
        const targetMember = headMember?.memberName || baseMember?.memberName;
        const isCallable = headMember?.callable || baseMember?.callable;
        const identityType = headMember?.identityType || baseMember?.identityType || '';
        if (!isCallable) {
          // Non-callable class fields (for example, locator properties) can affect all methods in this class.
          if (identityType === 'field' && targetClass) {
            addCallableMembersFromClassModel({ classModel: baseClass, className: targetClass, changedMethodsByClass });
            addCallableMembersFromClassModel({ classModel: headClass, className: targetClass, changedMethodsByClass });
          }
          continue;
        }
        addChangedMethod(changedMethodsByClass, targetClass, targetMember);
      }
    }
  }

  stats.semanticChangedMethodsCount = Array.from(changedMethodsByClass.values()).reduce((sum, methods) => sum + methods.size, 0);

  return {
    changedMethodsByClass,
    stats,
  };
};

const resolveCallableMemberKey = ({ className, memberName, callableMemberKeyByClassAndName, parentsByChild, mode }) => {
  // Resolve member names through class lineage for both this.* and super.* calls.
  if (!className || !memberName) return null;

  let current = mode === 'super' ? parentsByChild.get(className) : className;
  while (current) {
    const classMap = callableMemberKeyByClassAndName.get(current);
    if (classMap && classMap.has(memberName)) return classMap.get(memberName);
    current = parentsByChild.get(current);
  }

  return null;
};

const getCallableFunctionBodyNode = (memberNode) => {
  if (!memberNode) return null;
  if (ts.isConstructorDeclaration(memberNode)) return memberNode.body || null;
  if (ts.isMethodDeclaration(memberNode)) return memberNode.body || null;
  if (ts.isGetAccessorDeclaration(memberNode) || ts.isSetAccessorDeclaration(memberNode)) return memberNode.body || null;
  if (ts.isPropertyDeclaration(memberNode) && memberNode.initializer) {
    if (ts.isArrowFunction(memberNode.initializer) || ts.isFunctionExpression(memberNode.initializer)) {
      return memberNode.initializer.body;
    }
  }
  return null;
};

const hasChangedMethodInLineage = ({ className, memberName, changedMethodsByClass, parentsByChild }) => {
  let current = className;
  while (current) {
    const changedMethods = changedMethodsByClass.get(current);
    if (changedMethods && changedMethods.has(memberName)) return true;
    current = parentsByChild.get(current);
  }
  return false;
};

const resolveComposedFieldClassInLineage = ({
  className,
  fieldName,
  composedFieldClassByNameByClass,
  parentsByChild,
}) => {
  let current = className;
  while (current) {
    const fieldMap = composedFieldClassByNameByClass.get(current);
    const resolvedClass = fieldMap?.get(fieldName);
    if (resolvedClass) return resolvedClass;
    current = parentsByChild.get(current);
  }
  return null;
};

const getComposedClassesInLineage = ({
  className,
  composedFieldClassByNameByClass,
  parentsByChild,
}) => {
  const composedClasses = new Set();
  let current = className;
  while (current) {
    const fieldMap = composedFieldClassByNameByClass.get(current);
    if (fieldMap) {
      for (const composedClass of fieldMap.values()) composedClasses.add(composedClass);
    }
    current = parentsByChild.get(current);
  }
  return composedClasses;
};

/**
 * Propagate semantic seed through class call graph and return final impacted methods by class.
 * Includes inheritance and simple composition projection used by Stage B filtering.
 */
const buildImpactedMethodsByClass = ({ impactedClasses, changedMethodsByClass, parentsByChild, pageFiles }) => {
  // Propagation stage:
  // - build callable method graph from page files
  // - reverse-traverse callers from semantic seed methods
  // - project final method set back to impacted classes used by Stage B
  const impactedMethodsByClass = new Map();
  const stats = createEmptyStats();
  const warnings = [];
  const cache = createSemanticCache();

  const callableMemberKeyByClassAndName = new Map();
  const composedFieldClassByNameByClass = new Map();
  const composedClassToOwnerClasses = new Map();
  const callableNodeByMemberKey = new Map();
  const memberKeyParts = new Map();

  for (const filePath of pageFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parseFileModel({ refKind: 'head', absPath: filePath, content, cache });
    if (!parsed) continue;

    for (const [className, classModel] of parsed.classModels.entries()) {
      if (!callableMemberKeyByClassAndName.has(className)) callableMemberKeyByClassAndName.set(className, new Map());
      const classMap = callableMemberKeyByClassAndName.get(className);
      composedFieldClassByNameByClass.set(className, classModel.composedFieldClassByName);
      for (const composedClass of classModel.composedFieldClassByName.values()) {
        if (!composedClassToOwnerClasses.has(composedClass)) composedClassToOwnerClasses.set(composedClass, new Set());
        composedClassToOwnerClasses.get(composedClass).add(className);
      }

      for (const [memberName, memberModel] of classModel.callableMembersByName.entries()) {
        const memberKey = `${className}#${memberName}`;
        classMap.set(memberName, memberKey);
        memberKeyParts.set(memberKey, { className, memberName });
        if (memberModel.implementationNode) callableNodeByMemberKey.set(memberKey, memberModel.implementationNode);
      }
    }
  }

  const directEdges = new Map();

  for (const [callerKey, callerNode] of callableNodeByMemberKey.entries()) {
    const callerParts = memberKeyParts.get(callerKey);
    if (!callerParts) continue;

    const bodyNode = getCallableFunctionBodyNode(callerNode);
    if (!bodyNode) continue;

    const callees = new Set();
    const addAllClassMembersAsCallees = (className, mode = 'this') => {
      let current = mode === 'super' ? parentsByChild.get(className) : className;
      while (current) {
        const classMap = callableMemberKeyByClassAndName.get(current);
        if (classMap) {
          for (const memberKey of classMap.values()) callees.add(memberKey);
          return;
        }
        current = parentsByChild.get(current);
      }
      warnings.push(`Unresolvable ${mode} lineage for class ${className}`);
    };

    const getRootOfExpression = (expr) => {
      let current = expr;
      while (current && (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))) {
        current = current.expression;
      }
      return current;
    };

    const visit = (node) => {
      const isCallLike = ts.isCallExpression(node) || (typeof ts.isCallChain === 'function' && ts.isCallChain(node));
      if (isCallLike && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
        const calleeExpression = node.expression;
        const objectExpr = calleeExpression.expression;
        const methodName = ts.isPropertyAccessExpression(calleeExpression)
          ? (ts.isIdentifier(calleeExpression.name) ? calleeExpression.name.text : null)
          : getLiteralNameFromArgumentExpression(calleeExpression.argumentExpression);
        const isDynamicElementAccess = ts.isElementAccessExpression(calleeExpression) && !methodName;

        if (objectExpr.kind === ts.SyntaxKind.ThisKeyword) {
          if (methodName) {
            const calleeKey = resolveCallableMemberKey({
              className: callerParts.className,
              memberName: methodName,
              callableMemberKeyByClassAndName,
              parentsByChild,
              mode: 'this',
            });
            if (calleeKey) callees.add(calleeKey);
            else warnings.push(`Unresolvable this.${methodName} in ${callerParts.className}`);
          } else if (isDynamicElementAccess) {
            addAllClassMembersAsCallees(callerParts.className, 'this');
            warnings.push(`Dynamic this[...] call in ${callerParts.className} treated as uncertain`);
          }
        } else if (objectExpr.kind === ts.SyntaxKind.SuperKeyword) {
          if (methodName) {
            const calleeKey = resolveCallableMemberKey({
              className: callerParts.className,
              memberName: methodName,
              callableMemberKeyByClassAndName,
              parentsByChild,
              mode: 'super',
            });
            if (calleeKey) callees.add(calleeKey);
            else warnings.push(`Unresolvable super.${methodName} in ${callerParts.className}`);
          } else if (isDynamicElementAccess) {
            addAllClassMembersAsCallees(callerParts.className, 'super');
            warnings.push(`Dynamic super[...] call in ${callerParts.className} treated as uncertain`);
          }
        } else if (ts.isPropertyAccessExpression(objectExpr) || ts.isElementAccessExpression(objectExpr)) {
          if (!methodName) {
            ts.forEachChild(node, visit);
            return;
          }
          const chainRoot = getRootOfExpression(objectExpr);
          if (chainRoot && chainRoot.kind === ts.SyntaxKind.ThisKeyword && !getFieldNameFromThisPropertyAccess(objectExpr)) {
            addAllClassMembersAsCallees(callerParts.className, 'this');
            warnings.push(`Deep this.* chain in ${callerParts.className} treated as uncertain`);
            ts.forEachChild(node, visit);
            return;
          }
          const fieldName = getFieldNameFromThisPropertyAccess(objectExpr);
          if (!fieldName) {
            ts.forEachChild(node, visit);
            return;
          }
          const composedClass = resolveComposedFieldClassInLineage({
            className: callerParts.className,
            fieldName,
            composedFieldClassByNameByClass,
            parentsByChild,
          });
          if (!composedClass) {
            warnings.push(`Unknown composed field type for ${fieldName} in ${callerParts.className}`);
            ts.forEachChild(node, visit);
            return;
          }
          const calleeKey = resolveCallableMemberKey({
            className: composedClass,
            memberName: methodName,
            callableMemberKeyByClassAndName,
            parentsByChild,
            mode: 'this',
          });
          if (calleeKey) callees.add(calleeKey);
          else warnings.push(`Unresolvable composed call ${fieldName}.${methodName} in ${callerParts.className}`);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(bodyNode);
    directEdges.set(callerKey, callees);
  }

  const reverseEdges = new Map();
  for (const [caller, callees] of directEdges.entries()) {
    for (const callee of callees) {
      if (!reverseEdges.has(callee)) reverseEdges.set(callee, new Set());
      reverseEdges.get(callee).add(caller);
    }
  }

  const queue = [];
  const visited = new Set();

  for (const [className, methodNames] of changedMethodsByClass.entries()) {
    for (const methodName of methodNames) {
      const memberKey = resolveCallableMemberKey({
        className,
        memberName: methodName,
        callableMemberKeyByClassAndName,
        parentsByChild,
        mode: 'this',
      });
      if (!memberKey || visited.has(memberKey)) continue;
      visited.add(memberKey);
      queue.push(memberKey);
    }
  }

  while (queue.length > 0) {
    // BFS with visited set prevents loops on recursive/cyclic call chains.
    const current = queue.shift();
    const callers = reverseEdges.get(current) || new Set();
    for (const caller of callers) {
      if (visited.has(caller)) continue;
      visited.add(caller);
      queue.push(caller);
    }
  }

  const impactedMemberNames = new Set();
  for (const memberKey of visited) {
    const parts = memberKeyParts.get(memberKey);
    if (!parts) continue;
    impactedMemberNames.add(parts.memberName);
  }
  for (const methodNames of changedMethodsByClass.values()) {
    for (const methodName of methodNames) impactedMemberNames.add(methodName);
  }

  let classesForProjection = Array.from(callableMemberKeyByClassAndName.keys());
  if (impactedClasses.size > 0) {
    const childrenByParent = new Map();
    for (const [childClass, parentClass] of parentsByChild.entries()) {
      if (!childrenByParent.has(parentClass)) childrenByParent.set(parentClass, new Set());
      childrenByParent.get(parentClass).add(childClass);
    }

    const projectionSet = new Set(impactedClasses);
    const queueForComposition = Array.from(impactedClasses);
    while (queueForComposition.length > 0) {
      const currentClass = queueForComposition.shift();
      const owners = composedClassToOwnerClasses.get(currentClass) || new Set();
      for (const ownerClass of owners) {
        if (projectionSet.has(ownerClass)) continue;
        projectionSet.add(ownerClass);
        queueForComposition.push(ownerClass);
      }
    }

    const queueForDescendants = Array.from(projectionSet);
    while (queueForDescendants.length > 0) {
      const currentClass = queueForDescendants.shift();
      const children = childrenByParent.get(currentClass) || new Set();
      for (const childClass of children) {
        if (projectionSet.has(childClass)) continue;
        projectionSet.add(childClass);
        queueForDescendants.push(childClass);
      }
    }

    classesForProjection = Array.from(projectionSet);
  }
  for (const className of classesForProjection) {
    for (const memberName of impactedMemberNames) {
      const resolvedMemberKey = resolveCallableMemberKey({
        className,
        memberName,
        callableMemberKeyByClassAndName,
        parentsByChild,
        mode: 'this',
      });
      const isResolvedImpacted = Boolean(resolvedMemberKey && visited.has(resolvedMemberKey));
      const isRemovedOrRenamedInLineage = !resolvedMemberKey &&
        hasChangedMethodInLineage({ className, memberName, changedMethodsByClass, parentsByChild });

      let isComposedImpacted = false;
      if (!isResolvedImpacted && !isRemovedOrRenamedInLineage) {
        const composedClasses = getComposedClassesInLineage({
          className,
          composedFieldClassByNameByClass,
          parentsByChild,
        });
        for (const composedClass of composedClasses) {
          const composedMemberKey = resolveCallableMemberKey({
            className: composedClass,
            memberName,
            callableMemberKeyByClassAndName,
            parentsByChild,
            mode: 'this',
          });
          const isComposedResolvedImpacted = Boolean(composedMemberKey && visited.has(composedMemberKey));
          const isComposedRemovedOrRenamed =
            !composedMemberKey &&
            hasChangedMethodInLineage({
              className: composedClass,
              memberName,
              changedMethodsByClass,
              parentsByChild,
            });
          if (isComposedResolvedImpacted || isComposedRemovedOrRenamed) {
            isComposedImpacted = true;
            break;
          }
        }
      }

      if (!isResolvedImpacted && !isRemovedOrRenamedInLineage && !isComposedImpacted) continue;
      if (!impactedMethodsByClass.has(className)) impactedMethodsByClass.set(className, new Set());
      impactedMethodsByClass.get(className).add(memberName);
    }
  }

  stats.impactedMethodsTotal = Array.from(impactedMethodsByClass.values()).reduce((sum, methods) => sum + methods.size, 0);

  return {
    impactedMethodsByClass,
    stats,
    warnings,
  };
};

module.exports = {
  collectChangedMethodsByClass,
  buildImpactedMethodsByClass,
};
