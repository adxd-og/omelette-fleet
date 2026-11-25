/**
 * omelette-fleet :: units/gemini/test.mjs
 * gemini_test's answer: the unit's own header and round lines, each round's
 * test output as the unit measured it (its last 40 lines, fenced), Neon's last
 * message made unable to pass for the unit's lines, the files Neon changed
 * outside the test directories, and the diff under the unit's own heading.
 * And the tool itself (runGeminiTest): its gate, its refusals before any
 * spawn, the run, the program resolved once, agy under profile A with a scratch
 * home, the test command under profile B, the diff, the cleanup.
 *
 * THE ORDER — the gate (OMELETTE_ALLOW_REPRO), macOS, the arguments, the model
 * (gemini.testModel unless the call names one; never a Claude id), the deps
 * entries — all before any run dir exists. Then the budget clock starts
 * (gemini.testTimeoutS), the run is made (prepareTestRun), the deps copied, and
 * the test program, its PATH directories and its reach are resolved ONCE, with
 * one env, before agy first runs: from the second round on a dependency copy
 * is the test command's to write, so nothing derived from it may change what
 * the kernel allows (runTestCommand pins them).
 *
 * A ROUND — before its spawns the run's dirs are checked to be the ones made
 * (assertRun) and the clone's and tmp's own modes put back to 0700 (a test can
 * chmod them shut). agy runs through ctx.spawn — the env allowlist, the billing
 * scrub, the cancel signal and the live-group kill hold — with sandbox-exec put
 * in front: profile A, written once per run, and the binary it resolved, the
 * only one the profile lets run; cwd the clone, HOME the scratch home, TMPDIR
 * the run's tmp. Then the test command, under profile B.
 *
 * THE DIFF — taken only through testDiff, testChangedPaths and testGuards,
 * after `chmod -R u+rwX` over the clone under profile B (git skips a mode-000
 * directory silently); each caught: a failure is one line of the answer, never
 * the answer's loss.
 *
 * THE CLEANUP — a failure before any sandboxed spawn: discardRun. After one:
 * `chmod -R u+rwX` then `rm -rf` under profile B for the clone and tmp and
 * under profile A for the scratch home (rm's own unlink of each directory is
 * denied: it exits 1, and success is the directory being empty), then removeRun
 * removes the emptied directories. `gemini.testKeep` keeps the run.
 *
 * Never retried: a second run would execute the model's tests again.
 *
 * Zero deps.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { appendDiff, assertRun, longestRun, neutraliseModelText, removeRun } from '../../core/clone.mjs';
import { reproAllowed } from '../../core/config.mjs';
import { checkCwd } from '../../core/cwd.mjs';
import { INVISIBLE_CHARS } from '../../core/log.mjs';
import { SANDBOX_EXEC, sandboxExecFound } from '../../core/seatbelt.mjs';
import { HARD_KILL_GRACE_MS, parseAgyResult } from './agy.mjs';
import {
  checkDeps, checkTestCommand, copyDeps, discardRun, parsePrograms, prepareTestRun, profileBArgs, programNeeds, resolveProgram,
  runTestCommand, safeOutput, testChangedPaths, testDiff, testGuards, testRunsRoot, toolchainReach, writeProfileA,
} from './test-run.mjs';

/** The unit's heading the diff goes under. */
export const TEST_HEADING = '## proposed tests (not applied)';
/** That heading's name as a model may write it (demoteHeadings). */
export const TEST_HEADING_NAME = String.raw`proposed[ \t]+tests[ \t]*\([ \t]*not[ \t]+applied[ \t]*\)`;
/** The lines only the unit writes: marked model-written when Neon's message holds one. */
export const TEST_ADAPTER_LINES = String.raw`^[ \t]*(_\((gemini_test:|changed outside the test directories|no file outside the test directories|ignore or attributes files changed in the copy|the copy is unchanged|run kept:|diff unavailable:|Neon's last message is from round|Neon left no message|no output)|round \d+ · |\[gemini: )`;

/** The most names the outside list and the notice's list print. */
const LIST_MAX = 50;
/** The most characters (code points) of a name either list prints; a longer one is cut there and ends in an ellipsis (U+2026). */
const NAME_MAX = 200;
const INVISIBLE_ALL = new RegExp(INVISIBLE_CHARS.source, 'gu');

/**
 * A changed name as the answer prints it: as it is, or JSON-quoted when
 * safeOutput would change it, or it holds a control (C0, DEL, C1), a bidi or
 * zero-width character, U+2028/U+2029 (INVISIBLE_CHARS) or a comma — each such
 * character written as a `\uXXXX` escape (per UTF-16 unit), never raw.
 */
function quoteName(p) {
  const s = String(p);
  if (safeOutput(s) === s && !INVISIBLE_CHARS.test(s) && !s.includes(',')) return s;
  const hex = (c) => [...Array(c.length).keys()].map((i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join('');
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`).replace(INVISIBLE_ALL, hex)}"`;
}

/**
 * Names as one of the answer's lists prints them, joined by `, `: at most
 * LIST_MAX, then ` <ellipsis> and <n> more`; a name longer than NAME_MAX code
 * points cut to its first NAME_MAX followed by an ellipsis (U+2026), then
 * quoted (quoteName).
 */
function nameList(names) {
  const cut = (p) => { const cps = [...String(p)]; return cps.length > NAME_MAX ? `${cps.slice(0, NAME_MAX).join('')}\u{2026}` : String(p); };
  const more = names.length > LIST_MAX ? ` \u{2026} and ${names.length - LIST_MAX} more` : '';
  return `${names.slice(0, LIST_MAX).map((p) => quoteName(cut(p))).join(', ')}${more}`;
}

/** A caller's string made safe to print in one of the unit's lines: safeOutput, cut at its first newline. */
const oneSafeLine = (s) => safeOutput(String(s)).split('\n')[0];

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs']);
const TEST_FILE = [/^test_.*\.py$/, /_test\.(py|go)$/, /\.(test|spec)\.[cm]?[jt]sx?$/, /^conftest\.py$/];

/**
 * A path in the test directories: a directory component `test`, `tests`,
 * `__tests__`, `spec` or `specs`, or a test file by its base name.
 */
export function isTestPath(p) {
  const parts = String(p).split('/');
  const name = parts.pop();
  return parts.some((d) => TEST_DIRS.has(d)) || TEST_FILE.some((re) => re.test(name));
}

/** `text` in a fence of backticks one longer than its longest run (at least 3); one trailing newline dropped. */
export function fenced(text) {
  const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1));
  return `${fence}\n${text.replace(/\n$/, '')}\n${fence}`;
}

const secs = (ms) => (ms / 1000).toFixed(1);

/**
 * One round's line: agy's end and time, the test command's end and time (none
 * when `testMs` is null); each end made safe and cut at its first newline.
 */
export function roundLine({ k, agyEnd, agyMs, testEnd, testMs }) {
  const end = oneSafeLine(testEnd);
  const test = testMs === null || testMs === undefined ? end : `${end} (${secs(testMs)} s)`;
  return `round ${k} · agy: ${oneSafeLine(agyEnd)} (${secs(agyMs)} s) · test command: ${test}`;
}

/** The last 40 lines of a test output, made safe to show. */
function last40(tail) {
  const lines = safeOutput(tail).replace(/\n$/, '').split('\n');
  return lines.slice(-40).join('\n');
}

/**
 * gemini_test's answer, blocks joined by a blank line: the header; per round
 * its roundLine with, on the next line, its last 40 lines fenced or
 * `_(no output)_` (a round's `tail` is null when its log was empty or the test
 * command did not run); Neon's last message neutralised (headed by the round
 * it is from when that is not the last round), or `_(Neon left no message)_`
 * — the message goes through safeOutput before it is neutralised; the files of
 * `changed` outside the test directories (isTestPath), or the line saying there
 * are none; when `guards` (testGuards' names) holds any, the line naming them
 * (a model-written ignore or attributes file can hide files from the diff or
 * blank their content); both lists through nameList: at most 50 names, then
 * ` <ellipsis> and <n> more`, a name past 200 characters cut, an odd one quoted; the
 * diff under TEST_HEADING, or `_(the copy is unchanged)_`;
 * `_(run kept: <keptRun>)_` when a run dir is kept. When `unavailable` is a
 * string (the diff, the changed names or the guards could not be taken), the
 * outside list, the notice and the diff are one `_(diff unavailable: <it>)_`
 * line instead: a list or a diff without the others could mislead. `model`,
 * `ended`, `keptRun`, `unavailable` and each round's ends are made safe and cut
 * at their first newline (a caller may pass an error message); `rounds`,
 * `changed` and `guards` that are not arrays are refused.
 * @param {{model: string, argv: string[], rounds: {k: number, agyEnd: string, agyMs: number, testEnd: string, testMs: number|null, tail: string|null}[], maxRounds: number, ended: string, totalMs: number, lastMessage: string, lastFrom: number, diff: string, changed: string[], guards?: string[], keptRun?: string|null, unavailable?: string|null}} o
 * @returns {string}
 */
export function assembleAnswer({ model, argv, rounds, maxRounds, ended, totalMs, lastMessage, lastFrom, diff, changed, guards = [], keptRun, unavailable = null }) {
  if (!Array.isArray(rounds) || !Array.isArray(changed)) throw new Error('gemini: assembleAnswer needs rounds and changed as arrays');
  if (!Array.isArray(guards)) throw new Error('gemini: assembleAnswer needs guards as an array');
  const blocks = [`_(gemini_test: ${oneSafeLine(model)} · ${rounds.length} of at most ${maxRounds} rounds · ended: ${oneSafeLine(ended)} · ${secs(totalMs)} s · test command ${JSON.stringify(argv)})_`];
  for (const r of rounds) blocks.push(`${roundLine(r)}\n${r.tail === null || r.tail === undefined ? '_(no output)_' : fenced(last40(r.tail))}`);
  const message = safeOutput(String(lastMessage ?? ''));
  if (message.trim() === '') blocks.push('_(Neon left no message)_');
  else {
    const last = rounds.length ? rounds[rounds.length - 1].k : 0;
    if (lastFrom !== last) blocks.push(`_(Neon's last message is from round ${lastFrom})_`);
    blocks.push(neutraliseModelText(message, { headingName: TEST_HEADING_NAME, adapterLines: TEST_ADAPTER_LINES }));
  }
  if (typeof unavailable === 'string') blocks.push(`_(diff unavailable: ${oneSafeLine(unavailable)})_`);
  else {
    const outside = changed.filter((p) => !isTestPath(p));
    blocks.push(outside.length ? `_(changed outside the test directories: ${nameList(outside)})_` : '_(no file outside the test directories changed)_');
    if (guards.length) blocks.push(`_(ignore or attributes files changed in the copy: ${nameList(guards)} \u{2014} files they cover may be missing from this diff, or shown without their content)_`);
    blocks.push(appendDiff('', diff, { heading: TEST_HEADING, headingName: TEST_HEADING_NAME, unchanged: '_(the copy is unchanged)_' }).replace(/^\n+/, ''));
  }
  if (keptRun) blocks.push(`_(run kept: ${oneSafeLine(keptRun)})_`);
  return blocks.join('\n\n');
}

// --- the tool -------------------------------------------------------------------

/** The answer while the gate is closed. */
export const TEST_CLOSED = "Error: gemini_test is closed — set OMELETTE_ALLOW_REPRO=1 on the gemini unit's registration to let the model's tests run in a disposable copy (OMELETTE_ALLOW_WRITE does not open it)";

/** The session settings every round pins: no access outside the workspace, no permission granted — no `command` rule at all. */
export const TEST_SETTINGS = JSON.stringify({ allowNonWorkspaceAccess: false, permissions: { allow: [] } });

/** The refusal when the copy's directories are not the ones the unit made. */
const WITHHELD = 'gemini: the copy, its tmp or its scratch home was replaced during the run — the answer is withheld';

/** The ended word when no round may start. */
const BUDGET_SPENT = 'the call\'s budget (gemini.testTimeoutS) was spent';

/**
 * One round's agy argv: headless, JSON out, the model, no slash-command
 * expansion, accept-edits with the pinned settings, and `--conversation` to
 * resume. Never `--sandbox`, `--dangerously-skip-permissions`, `--mode auto` or
 * `--continue`.
 */
export function buildRoundArgs({ prompt, model, printS, conversation }) {
  return [
    '-p', prompt, '--output-format', 'json', '--print-timeout', `${printS}s`, '--model', model,
    '--disable-slash-commands', '--mode', 'accept-edits', '--settings', TEST_SETTINGS,
    ...(conversation ? ['--conversation', conversation] : []),
  ];
}

/** The unit's preamble of round 1: the brief follows it, after `The brief:`. The deps sentence only when there are deps. */
export function testPreamble({ argv, rounds, deps }) {
  const depsLine = deps.length ? `The dependency directories ${deps.join(', ')} are read-only: read them, do not write them. ` : '';
  return `You are a tester. The directory you are in is a disposable copy of a project at HEAD with a change applied and committed; nothing you write here reaches the real tree. Work from the files in this directory only; do not search the web. Write tests with your file tools only — create and edit files; run no command: you have no terminal. After you finish each message the unit runs the test command ${JSON.stringify(argv)} in this directory and sends you its output, for at most ${rounds} rounds in all.\n`
    + `The rounds are for tests that run, not for green. Fix what keeps a test from running as intended: a syntax error, an import, a fixture, a wrong helper. A test that fails because the code does what the brief or the spec says it must not stays as it is: never weaken an assertion to match the code; name that test in your last message as a candidate defect, with the spec line it rests on. Do not edit the code under test; if you must change a file outside the tests, say which and why. ${depsLine}Do not answer DONE before you have seen the output of a run. When the tests run and test what the brief asks, whatever their result, end your message with a last line that says DONE alone, after a short report: each test file, what it tests, and each candidate defect.`;
}

/** An error's message as one line. */
const messageOf = (e) => String((e && e.message) || e).trim().split(/\r\n|\r|\n/)[0];

/** `p` is `dir` or under it (both resolved). */
const within = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);

/** The usage pair of an agy envelope, or null when it reports none. */
function usageOf(parsed) {
  const u = parsed && parsed.usage;
  if (!u || typeof u !== 'object') return null;
  return { input: u.input_tokens ?? null, output: u.output_tokens ?? null };
}

/** One agy round's outcome read off its spawn result: `end`, the round line's word; `text`, Neon's message; `usage`. */
function readRound(res) {
  if (res.cancelled) return { end: 'cancelled', text: '', usage: null };
  const parsed = parseAgyResult(res.stdout);
  const text = parsed ? String(parsed.response ?? '').trim() : '';
  if (res.killed) return { end: 'hard-killed', text, usage: usageOf(parsed) };
  if (!parsed) return { end: `failed — agy exited ${res.code}: ${safeOutput(String(res.stderr || '')).trim().slice(-200)}`, text: '', usage: null };
  return { end: text ? 'answered' : 'no output', text, usage: usageOf(parsed) };
}

/** The test run's word for the round line. */
function testEndOf(r, { budgetBound }) {
  if (r.cancelled) return 'cancelled';
  if (r.killed) return budgetBound ? 'killed at gemini.testTimeoutS' : 'killed at gemini.testRunTimeoutS';
  if (r.code === null) return `signal ${r.signal}`;
  return `exit ${r.code}`;
}

/**
 * Before a spawn: the run's dirs are still the ones made (assertRun), then the
 * clone's and tmp's own modes back to 0700 — a test can chmod them shut.
 */
function readyRun(run) {
  assertRun(run, WITHHELD);
  chmodSync(run.clone, 0o700);
  chmodSync(run.tmp, 0o700);
}

/** `cmd` under profile B over the run (the clone and tmp writable), no shell, 120 s, its exit ignored. */
function underB(run, { home, fleet, reach }, cmd) {
  spawnSync(SANDBOX_EXEC, [...profileBArgs(run, { home, fleet, reach }), ...cmd], { cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: run.tmp }, stdio: 'ignore', timeout: 120_000 });
}

/** `cmd` under the run's profile A (the scratch home writable), no shell, 120 s, its exit ignored. */
function underA(run, cmd) {
  spawnSync(SANDBOX_EXEC, ['-f', run.profileA.profile, ...cmd], { cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: run.home }, stdio: 'ignore', timeout: 120_000 });
}

/**
 * The run removed after a sandboxed spawn: `chmod -R u+rwX` then `rm -rf` over
 * the clone and tmp under profile B and over the scratch home under profile A
 * (plainly, when no profile A was written: nothing sandboxed ran agy there);
 * rm exits 1 on each directory itself, whose unlink the profile denies — the
 * directories are emptied, and removeRun removes them outside the sandbox. A
 * profile that cannot be built leaves its directories as they are, logged.
 */
function removeSandboxedRun(run, o, log) {
  const chmodAll = () => {
    try { underB(run, o, ['/bin/chmod', '-R', 'u+rwX', run.clone, run.tmp]); } catch (e) { log(`gemini_test: profile B for the cleanup: ${messageOf(e)}`); }
    if (run.profileA) underA(run, ['/bin/chmod', '-R', 'u+rwX', run.home]);
  };
  const clear = () => {
    chmodAll();
    try { underB(run, o, ['/bin/rm', '-rf', run.clone, run.tmp]); } catch { /* logged by chmodAll */ }
    if (run.profileA) underA(run, ['/bin/rm', '-rf', run.home]);
    else spawnSync('/bin/rm', ['-rf', run.home], { stdio: 'ignore', timeout: 120_000 });
  };
  return removeRun(run.runDir, { log, dirs: ['clone', 'tmp', 'home'], clear, fix: chmodAll });
}

/** The operator's home, resolved: what both profiles deny, and the one the scratch home links Keychains from. */
const operatorHome = () => realpathSync(process.env.HOME || homedir());

const refuse = (text) => ({ text, isError: true });

/**
 * gemini_test: Neon writes tests in a disposable copy under profile A, the
 * unit runs the test command under profile B, the answer carries the unit's
 * round lines, Neon's last message and the diff (see the header).
 * @returns {Promise<{text: string, usage?: object|null, isError?: boolean, partial?: boolean}>}
 */
export async function runGeminiTest(args, ctx) {
  if (!reproAllowed()) return refuse(TEST_CLOSED);
  if (!sandboxExecFound()) return refuse(`Error: gemini_test: macOS only (1.13.0) — sandbox-exec is not available on ${process.platform}`);
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return refuse('Error: "prompt" is required.');
  const c = checkCwd(args.cwd);
  if (c.error) return refuse(c.error);
  if (!c.cwd) return refuse('Error: "cwd" is required: the top of the git work tree to copy');
  const argv = checkTestCommand(args.testCommand);
  const maxRounds = args.rounds === undefined ? 3 : args.rounds;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5) return refuse('Error: "rounds" must be a whole number from 1 to 5');
  const programs = parsePrograms(ctx.cfg.testPrograms);
  if (!ctx.model) return refuse(`Error: gemini.testModel "${ctx.cfg.testModel}" is not in the catalog — set it to a Gemini id (omelette-fleet set gemini.testModel=…)`);
  const entry = ctx.catalog.find(ctx.model);
  if (entry && entry.family === 'claude') return refuse(`Error: gemini_test does not run on a Claude model ("${ctx.model}"): a call is up to five agy runs on Antigravity's small, separate Claude quota`);
  if (args.deps !== undefined && !Array.isArray(args.deps)) return refuse('Error: "deps" must be an array of paths relative to cwd');
  const deps = checkDeps({ top: c.cwd, deps: args.deps || [], root: testRunsRoot() });

  const start = Date.now();
  const deadline = start + ctx.cfg.testTimeoutS * 1000;
  const home = operatorHome();
  const fleet = ctx.home;
  const keep = ctx.cfg.testKeep === true;
  const run = prepareTestRun({ cwd: c.cwd, patch: args.patch, home, log: ctx.log });
  let reach = null;
  try {
    copyDeps(run, deps, { log: ctx.log });
    // The program, its PATH directories and its reach: once, with one env, before agy first runs.
    const env = process.env;
    const word = argv[0];
    const program = resolveProgram({ word, programs, deps, run, env });
    const needs = programNeeds({ word, program, env });
    const top = realpathSync(run.top);
    for (const p of [needs.interpreter, ...needs.dirs]) {
      if (p && within(p, top)) throw new Error(`gemini: ${JSON.stringify(word)} needs ${JSON.stringify(p)}, which is in the work tree — the test command cannot read the work tree`);
    }
    const venvs = run.deps.filter((d) => existsSync(join(d.copy, 'pyvenv.cfg'))).map((d) => join(d.copy, 'bin', 'python'));
    reach = toolchainReach({ home, binaries: [program, ...(needs.interpreter ? [needs.interpreter] : []), ...venvs] });
    const testArgs = [program, ...argv.slice(1)];
    const timeoutS = ctx.cfg.timeoutS;
    // agy whole under profile A: the profile written once per run, the binary it resolved — every round the same.
    const wrap = (exe, a) => {
      const { profile, exe: bin } = writeProfileA(run, exe, { home, fleet });
      return { bin: SANDBOX_EXEC, args: ['-f', profile, bin, ...a] };
    };

    const rounds = [];
    let usage = null;
    let lastMessage = '';
    let lastFrom = 0;
    let ended = '';
    const k = 1;
    const left = deadline - Date.now();
    if (left < 1000) ended = BUDGET_SPENT;
    else {
      const printS = Math.max(1, Math.min(timeoutS, Math.floor((left - HARD_KILL_GRACE_MS) / 1000)));
      const hardKillMs = Math.min(timeoutS * 1000 + HARD_KILL_GRACE_MS, left);
      const roundText = `${testPreamble({ argv, rounds: maxRounds, deps })}\n\nThe brief:\n\n${prompt}`;
      readyRun(run);
      ctx.log(`gemini_test · round ${k} · model=${ctx.model} · print-timeout=${printS}s · hard-kill=${Math.round(hardKillMs / 1000)}s`);
      const t0 = Date.now();
      let round;
      try {
        const res = await ctx.spawn({
          args: buildRoundArgs({ prompt: roundText, model: ctx.model, printS }),
          cwd: run.clone,
          extraEnv: { HOME: run.home, TMPDIR: run.tmp },
          hardKillMs,
          killGroupOnExit: true,
          wrap,
        });
        round = readRound(res);
      } catch (e) {
        round = { end: `failed — ${messageOf(e)}`, text: '', usage: null };
      }
      const agyMs = Date.now() - t0;
      if (round.usage) usage = round.usage;
      if (round.text) { lastMessage = round.text; lastFrom = k; }
      const line = { k, agyEnd: round.end, agyMs, testEnd: 'not run', testMs: null, tail: null };
      rounds.push(line);
      ended = round.end === 'cancelled' ? 'cancelled' : round.end.startsWith('failed') ? 'agy failed' : 'rounds reached';
      if (!['cancelled'].includes(round.end) && !round.end.startsWith('failed')) {
        const limit = ctx.cfg.testRunTimeoutS * 1000;
        const timeoutMs = Math.min(limit, deadline - Date.now(), 2147483647);
        if (timeoutMs <= 0) line.testEnd = 'not run — the call\'s budget was spent';
        else {
          readyRun(run);
          try {
            const r = await runTestCommand(ctx, run, { args: testArgs, round: k, timeoutMs, reach, home, fleet, pathDirs: needs.dirs });
            Object.assign(line, { testEnd: testEndOf(r, { budgetBound: timeoutMs < limit }), testMs: r.ms, tail: r.tail });
          } catch (e) {
            ended = `the test command could not be run — ${messageOf(e)}`;
          }
        }
      }
    }

    assertRun(run, WITHHELD);
    let diff = '';
    let changed = [];
    let guards = [];
    let unavailable = null;
    try {
      // git skips a directory the test left mode 000 silently: the clone is made readable first, under profile B.
      underB(run, { home, fleet, reach }, ['/bin/chmod', '-R', 'u+rwX', run.clone]);
      diff = testDiff(run);
      changed = testChangedPaths(run);
      guards = testGuards(run);
    } catch (e) {
      unavailable = messageOf(e);
    }
    const text = assembleAnswer({
      model: ctx.model, argv, rounds, maxRounds, ended, totalMs: Date.now() - start, lastMessage, lastFrom,
      diff, changed, guards, keptRun: keep ? run.runDir : null, unavailable,
    });
    return { text, usage };
  } catch (e) {
    if (keep) throw new Error(`${messageOf(e)} — run kept: ${run.runDir}`);
    throw e;
  } finally {
    if (!keep) {
      if (run.sandboxed) removeSandboxedRun(run, { home, fleet, reach: reach || toolchainReach({ home, binaries: [] }) }, ctx.log);
      else discardRun(run);
    }
  }
}
