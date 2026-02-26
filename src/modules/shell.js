'use strict';

const { spawnSync } = require('child_process');

/**
 * Small spawnSync wrapper with normalized process result shape.
 */
const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    ...options,
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
};

module.exports = {
  runCommand,
};
