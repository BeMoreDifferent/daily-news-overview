import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

// The site is served straight from this branch, so exports only count as deployed once pushed there.
export const DEPLOY_BRANCH = 'master';
const NEWS_PATH = 'news/';
const GIT_TIMEOUT_MS = 60_000;

async function git(cwd, args) {
  const { stdout } = await execFile('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    // Fail fast instead of hanging on a credential prompt when run from launchd.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  return stdout.trim();
}

function commitMessage(nameStatus) {
  const entries = nameStatus.split('\n').filter(Boolean).map(line => {
    const [status, file] = line.split('\t');
    return { status, date: file.match(/(\d{4}-\d{2}-\d{2})\.json$/)?.[1] };
  }).filter(e => e.date);
  const added = entries.filter(e => e.status === 'A').map(e => e.date);
  const updated = entries.filter(e => e.status !== 'A').map(e => e.date);
  if (added.length === 1 && !updated.length) return `news: add ${added[0]} daily topics export`;
  const parts = [];
  if (added.length) parts.push(`add ${added.join(', ')}`);
  if (updated.length) parts.push(`update ${updated.join(', ')}`);
  return parts.length ? `news: ${parts.join('; ')} daily topics exports` : 'news: update index';
}

// Commits whatever changed under news/ (only those paths, never other staged work) and pushes
// while any news commit is still missing upstream. Idempotent, so callers run it after every
// export and the daemon runs it hourly: a failed push is retried until it lands.
// Returns { committed, pushed, skipped? }; git failures are thrown to the caller.
export async function publishNews({ cwd = process.cwd() } = {}) {
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== DEPLOY_BRANCH) {
    return { committed: false, pushed: false, skipped: `on branch ${branch}, not ${DEPLOY_BRANCH}` };
  }

  await git(cwd, ['add', '-A', '--', NEWS_PATH]);
  const staged = await git(cwd, ['diff', '--cached', '--name-status', '--', NEWS_PATH]);
  let committed = false;
  if (staged) {
    await git(cwd, ['commit', '-m', commitMessage(staged), '--', NEWS_PATH]);
    committed = true;
  }

  const unpushed = await git(cwd, ['log', '--format=%h', '@{u}..HEAD', '--', NEWS_PATH]);
  if (!unpushed) return { committed, pushed: false };
  await git(cwd, ['push']);
  return { committed, pushed: true };
}
