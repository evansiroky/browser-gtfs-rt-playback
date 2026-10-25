import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import rootConfig from '../eslint.config.js';

export default [
  ...rootConfig,
  reactHooks.configs.flat.recommended,
  {
    languageOptions: { globals: globals.browser },
  },
  {
    // Build tooling runs in Node.
    files: ['vite.config.ts', 'vitest.setup.ts'],
    languageOptions: { globals: globals.node },
  },
];
