import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeUrl } from '../src/utils/urlNormalizer.js';

test('normalizes tracking query and fragments', () => {
  assert.equal(
    normalizeUrl('https://Example.com/Article/?utm_source=x#comments'),
    'https://example.com/article'
  );
});

test('preserves youtube video id', () => {
  assert.equal(
    normalizeUrl('https://www.youtube.com/watch?v=AbC123&utm_source=x'),
    'https://www.youtube.com/watch?v=AbC123'
  );
});
