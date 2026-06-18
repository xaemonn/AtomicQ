// CJS shim for uuid — used by Jest (which runs in CommonJS mode)
// We use Node's built-in crypto to generate a real v4 UUID so tests
// still get unique IDs, identical in format to the ESM uuid package.
const { randomUUID } = require('crypto');

module.exports = {
  v4: () => randomUUID(),
};
