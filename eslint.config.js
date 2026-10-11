export default [
  {
    files: ['src/**/*.js', 'test/**/*.js', 'mcp/src/**/*.js', 'mcp/scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        BigInt: 'readonly',
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        TextDecoder: 'readonly',
        AbortSignal: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        structuredClone: 'readonly'
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
