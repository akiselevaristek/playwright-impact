'use strict';

const { analyzeImpactedSpecs } = require('./analyze-impacted-specs');
const { formatSelectionReasonsForLog } = require('./format-analyze-result');

// Public library surface.
module.exports = {
  analyzeImpactedSpecs,
  formatSelectionReasonsForLog,
};
