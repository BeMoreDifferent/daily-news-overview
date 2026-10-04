#!/usr/bin/env node
// Drop pictures the site cannot load from existing exports (see imageCheckService.js). New
// exports are checked when written; this cleans the archive, or re-checks days whose pictures
// have since gone dead. Only `image` fields change.
// Usage:
//   node scripts/checkNewsImages.js                    # every exported day
//   node scripts/checkNewsImages.js --date YYYY-MM-DD  # one day
//   --dry-run   report only, write nothing
//   --no-push   write files only; by default changes under news/ are committed and pushed

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dropUnloadableImages } from '../src/services/imageCheckService.js';
import { publishNews } from '../src/services/newsPublisher.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEWS_DIR = path.join(ROOT, 'news');

const args = process.argv.slice(2);
const dateIndex = args.indexOf('--date');
const onlyDate = dateIndex >= 0 ? args[dateIndex + 1] : null;
const dryRun = args.includes('--dry-run');
const push = !args.includes('--no-push') && !dryRun;

if (onlyDate && !/^\d{4}-\d{2}-\d{2}$/.test(onlyDate)) {
  console.error('--date needs YYYY-MM-DD');
  process.exit(1);
}

const { dates = [] } = JSON.parse(await fs.readFile(path.join(NEWS_DIR, 'index.json'), 'utf8'));
let changedDays = 0;
for (const date of onlyDate ? [onlyDate] : dates) {
  const file = path.join(NEWS_DIR, `${date}.json`);
  const raw = await fs.readFile(file, 'utf8');
  const data = JSON.parse(raw);
  const before = (data.topics || []).flatMap(topic => topic.articles || []).filter(article => article.image).length;
  const { kept } = await dropUnloadableImages(data.topics || []);
  const next = JSON.stringify(data, null, 2);
  const changed = next !== raw;
  console.log(`${date}: ${kept}/${before} pictures load${changed ? '' : ' (unchanged)'}`);
  if (!changed) continue;
  changedDays += 1;
  if (dryRun) continue;
  const tmp = path.join(NEWS_DIR, `.${date}.json.tmp`);
  await fs.writeFile(tmp, next, 'utf8');
  await fs.rename(tmp, file);
}
console.log(`\n${dryRun ? 'Would update' : 'Updated'} ${changedDays} day(s)`);

if (push && changedDays) {
  try {
    const result = await publishNews({ cwd: ROOT });
    if (result.skipped) console.warn(`Not published: ${result.skipped}`);
    else console.log(result.pushed ? 'Published: news/ pushed' : 'Published: nothing new to push');
  } catch (err) {
    console.error(`Publish failed (the daemon retries hourly): ${err.stderr || err.message}`);
    process.exitCode = 1;
  }
}
