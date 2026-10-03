import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishNews } from '../src/services/newsPublisher.js';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// A clone on master tracking a local bare "origin", with one initial commit pushed.
async function tempRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'news-publish-'));
  const remote = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'master', remote);
  git(dir, 'clone', '-q', remote, work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'checkout', '-q', '-b', 'master');
  await mkdir(path.join(work, 'news'));
  await writeFile(path.join(work, 'news', 'index.json'), '{"dates":[]}\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'master');
  return { work, remote };
}

const remoteHead = remote => git(remote, 'log', '-1', '--format=%s', 'master');

test('commits and pushes a new export', async () => {
  const { work, remote } = await tempRepo();
  await writeFile(path.join(work, 'news', '2026-10-02.json'), '{}\n');
  await writeFile(path.join(work, 'news', 'index.json'), '{"dates":["2026-10-02"]}\n');

  assert.deepEqual(await publishNews({ cwd: work }), { committed: true, pushed: true });
  assert.equal(remoteHead(remote), 'news: add 2026-10-02 daily topics export');
});

test('is a no-op when nothing changed', async () => {
  const { work } = await tempRepo();
  assert.deepEqual(await publishNews({ cwd: work }), { committed: false, pushed: false });
});

test('retries an earlier commit that never reached the remote', async () => {
  const { work, remote } = await tempRepo();
  await writeFile(path.join(work, 'news', '2026-10-01.json'), '{}\n');
  git(work, 'add', 'news');
  git(work, 'commit', '-q', '-m', 'news: add 2026-10-01 daily topics export');

  assert.deepEqual(await publishNews({ cwd: work }), { committed: false, pushed: true });
  assert.equal(remoteHead(remote), 'news: add 2026-10-01 daily topics export');
});

test('names added and updated dates and leaves other staged work out', async () => {
  const { work } = await tempRepo();
  await writeFile(path.join(work, 'news', '2026-09-30.json'), '{}\n');
  git(work, 'add', 'news');
  git(work, 'commit', '-q', '-m', 'partial day');
  await writeFile(path.join(work, 'news', '2026-09-30.json'), '{"full":true}\n');
  await writeFile(path.join(work, 'news', '2026-10-01.json'), '{}\n');
  await writeFile(path.join(work, 'notes.txt'), 'wip\n');
  git(work, 'add', 'notes.txt');

  await publishNews({ cwd: work });
  assert.equal(git(work, 'log', '-1', '--format=%s'), 'news: add 2026-10-01; update 2026-09-30 daily topics exports');
  assert.equal(git(work, 'diff', '--cached', '--name-only'), 'notes.txt');
});

test('does not commit on a branch other than master', async () => {
  const { work } = await tempRepo();
  git(work, 'checkout', '-q', '-b', 'feature');
  await writeFile(path.join(work, 'news', '2026-10-02.json'), '{}\n');

  const result = await publishNews({ cwd: work });
  assert.equal(result.committed, false);
  assert.match(result.skipped, /feature/);
  assert.equal(git(work, 'status', '--porcelain'), '?? news/2026-10-02.json');
});
