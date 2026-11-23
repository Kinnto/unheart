// Dev-only: runs the REAL content modules against the simulated Likes page.
import { createClickUnliker } from '../../content/clickUnliker.js';
import { createRunner } from '../../content/runner.js';
import { createClock, createFakeX, seeded, SCENARIOS, hasHardLimits } from './fakeX.js';

const LONG_WAIT_MS = 10_000;
const SETTLE_MS = 5_000;

export async function simulate({
  posts = 300,
  scenario = 'default',
  seed = 1,
  overrides = {},
  maxSimMs = 12 * 3600_000,
  maxWallMs = 120_000,
  secondPass = true,
} = {}) {
  if (!SCENARIOS[scenario]) throw new Error(`Unknown scenario: ${scenario}`);
  const clock = createClock();
  const sim = createFakeX({ clock, random: seeded(seed), posts, ...SCENARIOS[scenario], ...overrides });
  const runnerRandom = seeded(seed ^ 0x9e3779b9);
  const waits = [];
  const phases = [];
  const problems = [];
  const warnings = [];
  const t0 = clock.now();

  function makeRunner() {
    let runner;
    const unliker = createClickUnliker({
      doc: sim.doc,
      scroll: sim.scroll,
      scrollToTop: sim.scrollToTop,
      sleep: clock.sleep,
      now: clock.now,
    });
    // Trace each verdict against the server truth at the moment it is given.
    const verdicts = { ok: 0, failed: 0, 'rate-limited': 0, okWhileLiked: [] };
    const verify = unliker.verify;
    unliker.verify = async (item) => {
      const result = await verify(item);
      verdicts[result] = (verdicts[result] ?? 0) + 1;
      if (result === 'ok' && sim.serverLiked.has(item.id)) verdicts.okWhileLiked.push({ id: item.id, at: clock.now() });
      return result;
    };
    const sleep = (ms) => {
      if (ms >= LONG_WAIT_MS) waits.push({ at: clock.now() - t0, ms, kind: runner?.state.waitKind ?? '?' });
      return clock.sleep(ms);
    };
    runner = createRunner({ unliker, sleep, now: clock.now, random: runnerRandom });
    return { runner, unliker, verdicts };
  }

  async function phase(name, runner, go, verdicts) {
    const startAt = clock.now();
    const unlikedBefore = sim.unlikedCount();
    const removedBefore = runner.state.removed;
    const okWhileLikedBefore = verdicts.okWhileLiked.length;
    const promise = go();
    const drive = await clock.runUntil(promise, { maxSimMs, maxWallMs });
    const endAt = clock.now();
    const statusAtEnd = runner.state.status;
    if (drive.outcome !== 'settled') {
      // Cap reached (or a hang): press Stop, as a user would, and make sure
      // the run really ends before anything else happens on the page.
      runner.stop();
      const stopped = await clock.runUntil(promise, { maxSimMs: 60_000, maxWallMs });
      if (stopped.outcome !== 'settled') problems.push(`${name}: Stop did not end the run (${stopped.outcome})`);
    }
    await clock.advance(SETTLE_MS); // let in-flight server responses land
    const actuallyUnliked = sim.unlikedCount() - unlikedBefore;
    const removed = runner.state.removed - removedBefore;
    const p = {
      name,
      drive: drive.outcome,
      simMs: endAt - startAt,
      status: statusAtEnd,
      endReason: runner.state.endReason,
      error: runner.state.error,
      removed,
      failed: runner.state.failed,
      slowdowns: runner.state.slowdowns, // start() resets it, so per phase
      actuallyUnliked,
      likedAfter: sim.likedCount(),
      okWhileLiked: verdicts.okWhileLiked.slice(okWhileLikedBefore),
    };
    phases.push(p);
    if (drive.outcome === 'sim-timeout') {
      warnings.push(`${name}: still ${statusAtEnd} after the ${maxSimMs / 3600_000} h simulated-time cap (stopped; removed ${removed} so far)`);
    } else if (drive.outcome !== 'settled') {
      problems.push(`${name}: run did not terminate (${drive.outcome}${drive.error ? `: ${drive.error.stack}` : ''})`);
    }
    if (removed > actuallyUnliked) problems.push(`${name}: OVER-COUNT removed ${removed} > actually unliked ${actuallyUnliked}`);
    return p;
  }

  // Pass 1: Start, then "Retry them" if anything failed.
  const first = makeRunner();
  await phase('run', first.runner, () => first.runner.start(), first.verdicts);
  if (first.runner.state.failed > 0 && first.runner.state.status === 'done') {
    await phase('retry', first.runner, () => first.runner.retry(), first.verdicts);
  }
  const pass1Removed = first.runner.state.removed;
  const pass1Unliked = sim.unlikedCount();
  if (pass1Removed > pass1Unliked) problems.push(`pass 1: OVER-COUNT removed ${pass1Removed} > actually unliked ${pass1Unliked}`);

  // Pass 2: reload the page and run again from scratch.
  if (secondPass && sim.likedCount() > 0) {
    sim.reload();
    const second = makeRunner();
    await phase('reload+run', second.runner, () => second.runner.start(), second.verdicts);
  }

  const totalRemoved = pass1Removed + (phases.find((p) => p.name === 'reload+run')?.removed ?? 0);
  const totalUnliked = sim.unlikedCount();
  if (totalRemoved > totalUnliked) problems.push(`total: OVER-COUNT removed ${totalRemoved} > actually unliked ${totalUnliked}`);
  if (sim.stats.relikes > 0) problems.push(`re-liked ${sim.stats.relikes} post(s)`);

  const remaining = sim.likedCount();
  const hard = hasHardLimits(sim.options);
  if (!hard && remaining > 0) problems.push(`INCOMPLETE: ${remaining} post(s) still liked without hard limits`);

  return {
    posts,
    scenario,
    seed,
    hardLimits: hard,
    phases,
    pass1: { removed: pass1Removed, actuallyUnliked: pass1Unliked, simMs: phases.filter((p) => p.name !== 'reload+run').reduce((n, p) => n + p.simMs, 0) },
    totalRemoved,
    totalUnliked,
    remaining,
    waits,
    stats: sim.stats,
    problems,
    warnings,
    ok: problems.length === 0,
  };
}

const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}h ` : ''}${m}m ${String(s % 60).padStart(2, '0')}s`;
};

export function formatReport(r) {
  const lines = [];
  lines.push(`Unheart simulator — scenario=${r.scenario} posts=${r.posts} seed=${r.seed}${r.hardLimits ? ' (hard limits)' : ''}`);
  for (const p of r.phases) {
    const rate = p.simMs > 0 ? (p.actuallyUnliked / (p.simMs / 60_000)).toFixed(1) : '-';
    lines.push(`  [${p.name}] ${fmtDur(p.simMs)} sim, ${rate} unlikes/min — status=${p.status}${p.endReason ? `/${p.endReason}` : ''}${p.error ? ` error=${p.error}` : ''} drive=${p.drive}`);
    lines.push(`      removed=${p.removed} failed=${p.failed} slowdowns=${p.slowdowns} | server: unliked ${p.actuallyUnliked}, still liked ${p.likedAfter} | under-count ${p.actuallyUnliked - p.removed}${p.okWhileLiked.length ? ` | ok-before-server-confirmed ${p.okWhileLiked.length}` : ''}`);
  }
  const p1rate = r.pass1.simMs > 0 ? (r.pass1.actuallyUnliked / (r.pass1.simMs / 60_000)).toFixed(1) : '-';
  lines.push(`  Pass 1 (run + retry): ${fmtDur(r.pass1.simMs)}, ${p1rate} unlikes/min, removed ${r.pass1.removed} vs actually unliked ${r.pass1.actuallyUnliked}`);
  lines.push(`  HONESTY: total removed ${r.totalRemoved} <= actually unliked ${r.totalUnliked}: ${r.totalRemoved <= r.totalUnliked ? 'PASS' : 'FAIL'} (under-count ${r.totalUnliked - r.totalRemoved})`);
  lines.push(`  COMPLETENESS: ${r.remaining} still liked after reload+run${r.remaining > 0 ? (r.hardLimits ? ' (hard limits in play)' : ' — FLAG') : ''}`);
  const s = r.stats;
  lines.push(`  X side: clicks=${s.clicks} unlikeReq=${s.unlikeRequests} accepted=${s.accepted} rejected(limit/toast/revert)=${s.rejectedLimit}/${s.rejectedToast}/${s.rejectedRevert} relikes=${s.relikes} pageLoads=${s.pageLoads} loadErrors=${s.loadErrors} retryClicks=${s.retryClicks} maxDom=${s.maxDomArticles}`);
  const backoffs = r.waits.filter((w) => w.kind !== 'courtesy');
  lines.push(`  Long waits (${r.waits.length}; back-offs ${backoffs.length}):`);
  const shown = r.waits.slice(0, 40);
  for (const w of shown) lines.push(`      t=${fmtDur(w.at)} wait ${fmtDur(w.ms)} (${w.kind})`);
  if (r.waits.length > shown.length) lines.push(`      ... ${r.waits.length - shown.length} more`);
  for (const w of r.warnings) lines.push(`  WARN: ${w}`);
  lines.push(r.ok ? '  RESULT: OK' : `  RESULT: FAIL\n${r.problems.map((x) => `    - ${x}`).join('\n')}`);
  return lines.join('\n');
}
