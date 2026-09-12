// ESLint 扁平配置(eslint 10.x)
'use strict';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  require: 'readonly',
  module: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  localStorage: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  atob: 'readonly',
  Uint8Array: 'readonly',
  File: 'readonly',
  DataTransfer: 'readonly',
  DragEvent: 'readonly',
  Event: 'readonly',
  Image: 'readonly',
  getComputedStyle: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
};

module.exports = [
  {
    files: ['main.js', 'modules/**/*.js', 'ui/preload-ui.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
  },
  {
    // preload 脚本:既有 Node 侧能力(require/ipcRenderer),又直接操作页面 DOM(window/document)
    files: ['ui/webview-preload.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...nodeGlobals, ...browserGlobals },
    },
  },
  {
    // 本地 UI 的脚本:浏览器环境
    files: ['ui/floating.js', 'ui/menu.js', 'ui/pet.js', 'ui/main.js', 'ui/overlay.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: browserGlobals,
    },
  },
  {
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
];
