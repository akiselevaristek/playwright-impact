'use strict';

const path = require('path');

/**
 * Format selection reasons as log-friendly lines for CLI output.
 * The output is deterministic and can be truncated with maxLines.
 */
const formatSelectionReasonsForLog = ({ selectedSpecs, selectionReasons, repoRoot, maxLines = 40 }) => {
  if (!selectionReasons || typeof selectionReasons.get !== 'function' || selectedSpecs.length === 0) return '';

  const lines = [];
  for (const specPath of selectedSpecs) {
    const reason = selectionReasons.get(specPath);
    if (!reason) continue;
    lines.push(`       - ${path.relative(repoRoot, specPath)}: ${reason}`);
  }

  if (lines.length === 0) return '';
  if (lines.length <= maxLines) return lines.join('\n');

  const visible = lines.slice(0, maxLines);
  const hidden = lines.length - maxLines;
  return `${visible.join('\n')}\n       - ... ${hidden} more selected specs with reasons`;
};

module.exports = {
  formatSelectionReasonsForLog,
};
