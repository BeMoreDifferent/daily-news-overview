import assert from 'node:assert/strict';
import test from 'node:test';
import { dropUnloadableImages, isLoadableImage, pageImageUrl } from '../src/services/imageCheckService.js';

const ORIGIN = 'https://site.example';

// A fetch stand-in answering from a table of URL → { status, type, allow, redirected }.
function fakeFetch(table, calls = []) {
  return async (url, init) => {
    calls.push({ url, origin: init.headers.Origin });
    const entry = table[url];
    if (!entry) throw new TypeError('fetch failed');
    const headers = new Headers({ 'content-type': entry.type ?? 'image/jpeg' });
    if (entry.allow) headers.set('access-control-allow-origin', entry.allow);
    return { ok: (entry.status ?? 200) < 300, headers, redirected: Boolean(entry.redirected), body: null };
  };
}

test('pageImageUrl upgrades http and rejects other schemes', () => {
  assert.equal(pageImageUrl('http://a.example/x.jpg'), 'https://a.example/x.jpg');
  assert.equal(pageImageUrl('https://a.example/x.jpg'), 'https://a.example/x.jpg');
  assert.equal(pageImageUrl('data:image/png;base64,AAAA'), null);
  assert.equal(pageImageUrl('not a url'), null);
});

test('isLoadableImage needs an ok image response that allows the origin', async () => {
  const fetchImpl = fakeFetch({
    'https://a/star.jpg': { allow: '*' },
    'https://a/origin.jpg': { allow: ORIGIN },
    'https://a/other.jpg': { allow: 'https://elsewhere.example' },
    'https://a/none.jpg': {},
    'https://a/404.jpg': { allow: '*', status: 404 },
    'https://a/page.jpg': { allow: '*', type: 'text/html' },
    'https://a/moved.jpg': { allow: ORIGIN, redirected: true },
    'https://a/moved-star.jpg': { allow: '*', redirected: true },
  });
  const check = url => isLoadableImage(url, { origin: ORIGIN, fetchImpl });
  assert.equal(await check('https://a/star.jpg'), true);
  assert.equal(await check('https://a/origin.jpg'), true);
  assert.equal(await check('https://a/other.jpg'), false);
  assert.equal(await check('https://a/none.jpg'), false);
  assert.equal(await check('https://a/404.jpg'), false);
  assert.equal(await check('https://a/page.jpg'), false);
  assert.equal(await check('https://a/moved.jpg'), false, 'cross-origin redirect sends Origin: null');
  assert.equal(await check('https://a/moved-star.jpg'), true);
  assert.equal(await check('https://a/unreachable.jpg'), false);
});

test('dropUnloadableImages keeps loadable pictures as https and checks each URL once', async () => {
  const calls = [];
  const fetchImpl = fakeFetch({ 'https://a/ok.jpg': { allow: '*' }, 'https://a/blocked.jpg': {} }, calls);
  const topics = [
    { articles: [{ image: 'http://a/ok.jpg' }, { image: 'https://a/blocked.jpg' }, { title: 'no image' }] },
    { articles: [{ image: 'https://a/ok.jpg' }, { image: 'javascript:alert(1)' }] },
  ];
  const result = await dropUnloadableImages(topics, { origin: ORIGIN, fetchImpl });

  assert.deepEqual(result, { checked: 2, kept: 2 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.origin === ORIGIN));
  assert.deepEqual(topics[0].articles, [{ image: 'https://a/ok.jpg' }, {}, { title: 'no image' }]);
  assert.deepEqual(topics[1].articles, [{ image: 'https://a/ok.jpg' }, {}]);
});
