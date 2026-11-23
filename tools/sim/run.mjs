#!/usr/bin/env node
// Dev-only CLI: node tools/sim/run.mjs --posts 300 [--scenario default|noisy|limited|harsh] [--seed 1]
import { simulate, formatReport } from './simulate.js';
import { SCENARIOS } from './fakeX.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const posts = Number(opt('posts', 300));
const seed = Number(opt('seed', 1));
const scenarioArg = opt('scenario', 'default');
const scenarios = scenarioArg === 'all' ? Object.keys(SCENARIOS) : [scenarioArg];
const maxWallMs = Number(opt('max-wall-s', 600)) * 1000;

if (!Number.isInteger(posts) || posts < 1) throw new Error('--posts must be a positive integer');
for (const s of scenarios) if (!SCENARIOS[s]) throw new Error(`Unknown scenario "${s}" (use ${Object.keys(SCENARIOS).join('|')}|all)`);

let failed = false;
for (const scenario of scenarios) {
  const wall = Date.now();
  const report = await simulate({ posts, scenario, seed, maxWallMs });
  console.log(formatReport(report));
  console.log(`  (wall time ${((Date.now() - wall) / 1000).toFixed(1)} s)\n`);
  if (!report.ok) failed = true;
}
process.exit(failed ? 1 : 0);
