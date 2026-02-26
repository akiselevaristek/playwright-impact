'use strict';

const parseClassNames = (content) => {
  if (!content) return new Set();
  const names = new Set();
  const re = /(?:export\s+)?class\s+([A-Za-z_]\w*)/g;
  let match = re.exec(content);
  while (match) {
    names.add(match[1]);
    match = re.exec(content);
  }
  return names;
};

/**
 * Build simple inheritance lookup maps from source files.
 * These maps are reused in class impact and method propagation stages.
 */
const buildInheritanceGraph = (pageFiles, readFile) => {
  // Build parent/child lookup once so both Stage A and method propagation can resolve lineage.
  const parentsByChild = new Map();
  const childrenByParent = new Map();

  for (const filePath of pageFiles) {
    const content = readFile(filePath, 'utf8');
    const re = /(?:export\s+)?class\s+([A-Za-z_]\w*)\s+extends\s+([A-Za-z_]\w*)/g;
    let match = re.exec(content);
    while (match) {
      const child = match[1];
      const parent = match[2];
      parentsByChild.set(child, parent);
      if (!childrenByParent.has(parent)) childrenByParent.set(parent, new Set());
      childrenByParent.get(parent).add(child);
      match = re.exec(content);
    }
  }

  return { parentsByChild, childrenByParent };
};

/**
 * Collect changed classes from base/head content and include all descendants.
 * Descendant expansion prevents missing specs bound to inherited behavior.
 */
const collectImpactedClasses = ({ changedPomEntries, childrenByParent, baseRef, readChangeContents }) => {
  // Seed impacted classes from both base and head versions, then include descendants.
  // This keeps fixture preselection safe for renamed files and inheritance-heavy POM trees.
  const impacted = new Set();

  for (const entry of changedPomEntries) {
    const { baseContent, headContent } = readChangeContents(entry, baseRef);
    for (const className of parseClassNames(baseContent)) impacted.add(className);
    for (const className of parseClassNames(headContent)) impacted.add(className);
  }

  const queue = [...impacted];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = childrenByParent.get(current) || new Set();
    for (const child of children) {
      if (impacted.has(child)) continue;
      impacted.add(child);
      queue.push(child);
    }
  }

  return impacted;
};

/**
 * Convert impacted classes to fixture keys used in Stage A spec preselection.
 */
const getFixtureKeysForClasses = (impactedClasses, classToFixtureKeys) => {
  const keys = new Set();
  for (const className of impactedClasses) {
    const mappedKeys = classToFixtureKeys.get(className) || new Set();
    for (const key of mappedKeys) keys.add(key);
  }
  return keys;
};

module.exports = {
  buildInheritanceGraph,
  collectImpactedClasses,
  getFixtureKeysForClasses,
};
