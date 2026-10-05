const { defineConfig } = require('@vscode/test-cli');

module.exports = defineConfig([
  {
    files: 'out/test/**/*.test.js',
    extensionDevelopmentPath: __dirname,
    sourceMap: true,
    mocha: {
      ui: 'tdd',
      timeout: 20000
    }
  }
]);
