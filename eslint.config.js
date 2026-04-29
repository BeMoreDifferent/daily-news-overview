export default [
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        BigInt: 'readonly',
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly'
      }
    },
    rules: {
      indent: ['error', 2],
      'linebreak-style': ['error', 'unix'],
      quotes: ['error', 'single'],
      semi: ['error', 'always'],
      'no-unused-vars': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error', 'info', 'log'] }]
    }
  }
];
