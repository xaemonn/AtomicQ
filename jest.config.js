/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  verbose: true,
  forceExit: true,
  clearMocks: true,
  detectOpenHandles: true,
  testTimeout: 30000,
  // Redirect uuid (pure ESM, no CJS build) to our CJS shim
  moduleNameMapper: {
    '^uuid$': '<rootDir>/tests/__mocks__/uuid.js',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
};