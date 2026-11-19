#!/usr/bin/env node
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { fmtMs } from './stress/util.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function pad(value, width, right = false) {
  const s = String(value ?? '');
  return right ? s.padStart(width) : s.padEnd(width);
}

function usage() {
  console.log(`
Usage: npm run release <patch|minor|major|X.Y.Z> [--skip-stress] [--yes]

Runs the test suite, then a stress sweep against the local server, before
touching the version. Any test failure aborts the release.

Examples:
  npm run release patch   # 1.0.5 -> 1.0.6
  npm run release minor   # 1.0.5 -> 1.1.0
  npm run release major   # 1.0.5 -> 2.0.0
  npm run release 2.0.0   # explicit version

Options:
  --skip-stress           skip the stress sweep (tests still run)
  --yes                   proceed without the interactive confirmation

Environment:
  STRESS_BASE_URL         running local server (default http://localhost:7777)
  STRESS_DB_URI_LOCAL     stress DB (default mongodb://localhost:27017/shopik_stress)
  STRESS_ID_NUM           admin idNum (else prompted; OTP is always headless)
  STRESS_USER_PHONE       shopper for the storefront routes (else sampled from the stress DB)
  STRESS_GATE_PASSWORD    site gate password, if the target has one
`);
}

const args = process.argv.slice(2);
const knownFlags = new Set(['--skip-stress', '--yes', '--help', '-h']);
for (const arg of args) {
  if (arg.startsWith('-') && !knownFlags.has(arg)) fail(`Unknown option "${arg}".`);
}

const skipStress = args.includes('--skip-stress');
const assumeYes = args.includes('--yes');
const requested = args.find(arg => !arg.startsWith('-'));

if (!requested || args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(args.includes('--help') || args.includes('-h') ? 0 : 1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const current = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!current) fail(`Unsupported current version "${pkg.version}" (expected X.Y.Z).`);

const [, major, minor, patch] = current.map(Number);

let next;
if (requested === 'patch') next = `${major}.${minor}.${patch + 1}`;
else if (requested === 'minor') next = `${major}.${minor + 1}.0`;
else if (requested === 'major') next = `${major + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(requested)) next = requested;
else fail(`Unknown release type "${requested}". Use patch, minor, major, or an explicit X.Y.Z version.`);

if (git('status', '--porcelain')) {
  fail('Working tree is not clean. Commit or stash your changes before releasing.');
}

const branch = git('branch', '--show-current');
if (branch !== 'main') {
  fail(`Releases must start from main (currently on "${branch}").`);
}

const releaseBranch = `release/${next}`;
if (git('branch', '--list', releaseBranch)) {
  fail(`Branch "${releaseBranch}" already exists.`);
}

// Everything before the bump is read-only: a failed test, a failed stress run
// or a "no" at the prompt leaves package.json and git history untouched.

console.log('\n▶ Running the test suite (npm test)');
try {
  execSync('npm test', { cwd: root, stdio: 'inherit' });
} catch {
  fail('Tests failed — release aborted. No version bump was made.');
}
console.log('✔ Tests passed');

// Stress config: explicit env wins; the admin idNum is prompted by the stress
// tool if absent. OTP is ALWAYS headless: the storefront routes (order/cart/get,
// order/window/options, …) log in a shopper too, and no one can read an OTP sent
// to that shopper's real phone.
const stressBaseUrl = process.env.STRESS_BASE_URL || 'http://localhost:7777';
const stressDbUri = process.env.STRESS_DB_URI_LOCAL || 'mongodb://localhost:27017/shopik_stress';
const stressIdNum = process.env.STRESS_ID_NUM || null;
const stressUserPhone = process.env.STRESS_USER_PHONE || null;
const stressGatePassword = process.env.STRESS_GATE_PASSWORD || null;
const stressReportDir = path.join('reports', 'stress', `release-${next}`);

function newestReport(dir) {
  const absolute = path.resolve(root, dir);
  if (!existsSync(absolute)) return null;
  const files = readdirSync(absolute)
    .filter(file => file.endsWith('.json'))
    .map(file => path.join(absolute, file));
  if (!files.length) return null;
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0];
}

async function assertServerReachable(baseUrl) {
  try {
    await fetch(new URL('/api/domain/count', baseUrl), { signal: AbortSignal.timeout(5000) });
  } catch {
    fail(`Cannot reach the local server at ${baseUrl}.\n\n`
      + 'Start it against the stress DB first, e.g.\n'
      + `  DB=${stressDbUri} NO_NIGHT_SYNC=1 PORT=7777 npm start\n\n`
      + 'or set STRESS_BASE_URL to the running server.');
  }
}

async function confirm(question) {
  if (assumeYes) {
    console.log(`${question}yes (--yes)`);
    return true;
  }
  if (!process.stdin.isTTY) {
    fail('Refusing to release without confirmation: stdin is not interactive. Re-run with --yes.');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

let stressReport = null;

if (skipStress) {
  console.log('\n⚠ Stress run skipped (--skip-stress).');
} else {
  console.log(`\n▶ Stress-testing ${stressBaseUrl} (~15-20 min for a full sweep)`);
  await assertServerReachable(stressBaseUrl);
  if (assumeYes && !stressIdNum) {
    fail('--yes needs STRESS_ID_NUM: the stress run cannot prompt for the admin idNum non-interactively.');
  }

  const stressArgs = [
    'scripts/stress/run.js',
    '--target', 'local',
    '--mode', 'sequential',
    '--db-uri', stressDbUri,
    '--base-url', stressBaseUrl,
    '--report-dir', stressReportDir,
    '--headless-otp'
  ];
  if (stressIdNum) stressArgs.push('--id-num', stressIdNum);
  if (stressUserPhone) stressArgs.push('--user-phone', stressUserPhone);
  if (stressGatePassword) stressArgs.push('--gate-password', stressGatePassword);

  try {
    execFileSync(process.execPath, stressArgs, { cwd: root, stdio: 'inherit' });
  } catch {
    fail('Stress run failed — release aborted. No version bump was made.');
  }

  stressReport = newestReport(stressReportDir);
  if (!stressReport) fail('Stress run wrote no JSON report — release aborted.');

  const report = JSON.parse(readFileSync(stressReport, 'utf8'));
  const slowest = (report.sequential || [])
    .filter(row => !row.skipped && row.p95Ms != null)
    .sort((a, b) => b.p95Ms - a.p95Ms || (b.p50Ms ?? 0) - (a.p50Ms ?? 0))
    .slice(0, 5);
  if (!slowest.length) fail('Stress report has no measured routes — release aborted.');

  console.log(`\n── top ${slowest.length} slowest routes (by p95) ${'─'.repeat(46)}`);
  console.log(pad('#', 3, true) + '  ' + pad('route', 34)
    + pad('p50', 9, true) + pad('p95', 9, true) + pad('calls', 7, true) + '  verdict');
  slowest.forEach((row, index) => {
    console.log(pad(index + 1, 3, true) + '  ' + pad(row.route, 34)
      + pad(fmtMs(row.p50Ms), 9, true) + pad(fmtMs(row.p95Ms), 9, true)
      + pad(row.calls ?? '—', 7, true) + '  ' + (row.verdict || '—'));
  });
  console.log(`\nfull report: ${stressReport}`);
}

if (!(await confirm(`\nProceed with release v${next}? [y/N] `))) {
  fail('Release aborted — no version bump was made.');
}

// The checks ran the app and the stress tool; make sure they left no tracked
// changes behind before committing the bump.
if (git('status', '--porcelain')) {
  fail('Working tree changed during the release checks. Commit or stash those changes and re-run.');
}

console.log(`\nBumping main ${pkg.version} → ${next}`);
try {
  execSync(`npm version ${next} --no-git-tag-version`, { cwd: root, stdio: 'inherit' });
} catch {
  fail('Failed to bump the version. main has no commit made.');
}

const files = ['package.json'];
if (existsSync(lockPath)) files.push('package-lock.json');
git('add', ...files);
git('commit', '-m', `chore(release): v${next}`);

console.log(`✔ Bumped main to v${next}`);
console.log(`Creating ${releaseBranch} at the bump commit`);
git('switch', '--no-track', '-c', releaseBranch);

console.log(`
✔ Bumped main to v${next} and created ${releaseBranch}${skipStress ? ' (stress skipped)' : ''}
${stressReport ? `\nStress report: ${stressReport}\n` : ''}
Nothing has been pushed.

Next steps:
  git push -u origin ${releaseBranch}
  open a pull request from ${releaseBranch} into main
`);
