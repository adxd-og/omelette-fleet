import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit, { deepResearchModel, interpretAgy, parseSubquestions, stageModels, catalog } from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';
import { parseResult } from '../core/results.mjs';

const ok = (over = {}) => ({ stdout: '', stderr: '', code: 0, killed: false, ...over });
const envelope = (o) => JSON.stringify({ status: 'SUCCESS', response: 'answer', usage: { input_tokens: 10, output_tokens: 3 }, ...o });

test('interpretAgy: clean JSON turn → text + usage; envelope status drives the outcome', () => {
  const r = interpretAgy(ok({ stdout: envelope({}) }), { timeoutS: 300 });
  assert.equal(r.text, 'answer');
  assert.deepEqual(r.usage, { input: 10, output: 3 });
  const early = interpretAgy(ok({ stdout: envelope({ status: 'TIMEOUT' }) }), { timeoutS: 300 });
  assert.match(early.text, /run ended early — status=TIMEOUT/);
  assert.throws(() => interpretAgy(ok({ stdout: envelope({ status: 'TIMEOUT', response: '' }) }), { timeoutS: 300 }), /no answer \(status=TIMEOUT\)/);
});

test('interpretAgy: a successful answer ABOUT quotas is never misread as exhaustion', () => {
  const r = interpretAgy(ok({ stdout: envelope({ response: 'RESOURCE_EXHAUSTED means the quota was exceeded' }) }), { timeoutS: 300 });
  assert.match(r.text, /RESOURCE_EXHAUSTED/);
});

test('interpretAgy: failed turns — quota, hard-kill, silent stderr-only, non-zero exit', () => {
  assert.throws(() => interpretAgy(ok({ stdout: '', stderr: 'RESOURCE_EXHAUSTED', code: 1 }), { timeoutS: 300 }), /quota exhausted/);
  assert.throws(() => interpretAgy(ok({ stdout: '', killed: true }), { timeoutS: 300 }), /hard-killed after 360s/);
  assert.throws(() => interpretAgy(ok({ stdout: '', stderr: 'a tool required the "read_url" permission' }), { timeoutS: 300 }), /produced no output: a tool required/);
  assert.throws(() => interpretAgy(ok({ stdout: '', stderr: 'boom', code: 2 }), { timeoutS: 300 }), /agy exited 2: boom/);
});

test('interpretAgy: a hard kill with a captured answer returns it under a partial marker', () => {
  const r = interpretAgy(ok({ stdout: envelope({}), code: null, killed: true }), { timeoutS: 300 });
  assert.equal(r.partial, true);
  assert.match(r.text, /^answer/);
  assert.match(r.text, /\[gemini: hard-killed after 360s — treat the answer as partial; raise gemini\.timeoutS in the fleet config\]/);
  assert.deepEqual(r.usage, { input: 10, output: 3 });
  // Non-JSON stdout is salvaged the same way the clean path reads it.
  assert.match(interpretAgy(ok({ stdout: 'plain half answer', code: null, killed: true }), { timeoutS: 300 }).text, /^plain half answer/);
  // Nothing captured: still an error, and quota exhaustion still wins over it.
  assert.throws(() => interpretAgy(ok({ stdout: '   ', code: null, killed: true }), { timeoutS: 300 }), /hard-killed after 360s/);
  assert.throws(() => interpretAgy(ok({ stdout: envelope({}), stderr: 'RESOURCE_EXHAUSTED', code: null, killed: true }), { timeoutS: 300 }), /quota exhausted/);
});

test('interpretAgy: a non-zero exit WITH text keeps the text under a partial marker', () => {
  const r = interpretAgy(ok({ stdout: envelope({}), code: 1, stderr: 'wobble' }), { timeoutS: 300 });
  assert.match(r.text, /^answer/);
  assert.match(r.text, /\[gemini: CLI exited 1 — treat the answer as partial\]/);
  // Both annotations land when the turn also reported a non-SUCCESS status.
  const both = interpretAgy(ok({ stdout: envelope({ status: 'TIMEOUT' }), code: 1 }), { timeoutS: 300 });
  assert.match(both.text, /run ended early — status=TIMEOUT/);
  assert.match(both.text, /CLI exited 1/);
});

test('interpretAgy: non-JSON stdout fails OPEN to the raw text', () => {
  const r = interpretAgy(ok({ stdout: 'plain old answer' }), { timeoutS: 300 });
  assert.equal(r.text, 'plain old answer');
  assert.equal(r.usage, null);
});

// --- output cap ---------------------------------------------------------------

/** The exact marker every capped answer carries, for the cap the run was spawned under. */
const CAP_MARK = (n) => new RegExp(`\\[gemini: output capped at ${n} chars — the beginning of the stream was dropped; treat the answer as partial\\]`);

test('interpretAgy: a front-truncated envelope is a marked partial answer, or a loud error — never a fragment', () => {
  const opts = { timeoutS: 300, outputCap: 2000 };
  // agy printed something ahead of its envelope and the cap took exactly that:
  // the envelope is whole, the run is not.
  const marked = interpretAgy(ok({ stdout: envelope({}), capped: true }), opts);
  assert.match(marked.text, /^answer/);
  assert.match(marked.text, CAP_MARK(2000));
  assert.equal(marked.partial, true);
  assert.deepEqual(marked.usage, { input: 10, output: 3 });
  // The cap cut the envelope OPEN: parseAgyResult rejects it, and the raw-stdout
  // fail-open — which exists for a CLI that printed plain text — would hand back
  // the middle of a JSON object as if it were the answer.
  assert.throws(
    () => interpretAgy(ok({ stdout: '"response": "the tail of a long answer"}', capped: true }), opts),
    /^Error: agy output exceeded the 2000 char cap and the answer envelope was lost — raise gemini\.outputCap or narrow the task$/,
  );
  // `capped` is read off the run when the option is omitted, and `outputCap`
  // then falls back to the fleet cap rather than printing "undefined".
  assert.throws(
    () => interpretAgy(ok({ stdout: 'fragment', capped: true }), { timeoutS: 300 }),
    /^Error: agy output exceeded the 400000 char cap and the answer envelope was lost — raise gemini\.outputCap or narrow the task$/,
  );
  // An explicit `capped: false` wins over the run's own flag: an uncapped run
  // whose stdout is not JSON still fails open to the raw text.
  assert.equal(interpretAgy(ok({ stdout: 'plain old answer', capped: true }), { timeoutS: 300, capped: false }).text, 'plain old answer');
  // Quota exhaustion still wins: it names the actual cause, and no cap explains it.
  assert.throws(() => interpretAgy(ok({ stdout: 'RESOURCE_EXHAUSTED', capped: true, code: 1 }), opts), /quota exhausted/);
});

test('interpretAgy: a run that was hard-killed AND capped answers the kill first', () => {
  const opts = { timeoutS: 300, outputCap: 2000 };
  const both = interpretAgy(ok({ stdout: envelope({}), capped: true, code: null, killed: true }), opts);
  assert.match(both.text, /^answer/);
  assert.match(both.text, /\[gemini: hard-killed after 360s — treat the answer as partial; raise gemini\.timeoutS in the fleet config\]/);
  assert.match(both.text, CAP_MARK(2000));
  assert.equal(both.partial, true);
  // Killed with an envelope the cap cut open: there is nothing to salvage, and
  // the error names both bounds instead of dressing a fragment up as an answer.
  assert.throws(
    () => interpretAgy(ok({ stdout: '"response": "half"}', capped: true, code: null, killed: true }), opts),
    /^Error: agy hard-killed after 360s and output exceeded the 2000 char cap — raise gemini\.timeoutS or gemini\.outputCap in the fleet config$/,
  );
  // An uncapped kill with nothing captured keeps naming only timeoutS.
  assert.throws(
    () => interpretAgy(ok({ stdout: '', code: null, killed: true }), opts),
    /^Error: agy hard-killed after 360s \(raise gemini\.timeoutS in the fleet config\)$/,
  );
});

test('interpretAgy: a run the CLIENT cancelled says so — neither timeoutS nor outputCap is the fix', () => {
  const opts = { timeoutS: 300, outputCap: 2000 };
  // core/spawn.mjs flags the same SIGKILL `cancelled` when it answered an abort
  // rather than the hard-kill timer: "raise gemini.timeoutS" would send the
  // operator after a bound that held.
  const salvaged = interpretAgy(ok({ stdout: envelope({}), code: null, killed: true, cancelled: true }), opts);
  assert.match(salvaged.text, /^answer/);
  assert.match(salvaged.text, /\[gemini: cancelled by the client — treat the answer as partial\]/);
  assert.doesNotMatch(salvaged.text, /hard-killed/);
  assert.equal(salvaged.partial, true);
  // Nothing salvaged, and the cap does not get the blame either.
  assert.throws(
    () => interpretAgy(ok({ stdout: '', code: null, killed: true, cancelled: true, capped: true }), opts),
    /^Error: agy cancelled by the client$/,
  );
});

test('parseSubquestions extracts and caps the first string array', () => {
  assert.deepEqual(parseSubquestions('here: ["a", "b", "c"] done', 2), ['a', 'b']);
  assert.deepEqual(parseSubquestions('{"subquestions":["x"]}', 3), ['x']);
  assert.equal(parseSubquestions('nothing', 3), null);
});

test('stageModels picks by catalog shape so a generation sweep never strands an id', () => {
  const s = stageModels(catalog);
  assert.ok(catalog.isAllowedModel(s.decompose));
  assert.ok(catalog.isAllowedModel(s.synth));
  assert.match(s.decompose, /Flash \(Medium\)$/);
  assert.match(s.synth, /Flash \(High\)$/);
  assert.deepEqual(stageModels(catalog, 'X'), { decompose: 'X', gather: 'X', synth: 'X' });
});

test('deepResearchModel: the stage ids the run asked for, collapsed when every stage shares one', () => {
  // The composite a default run is filed under: decompose and gather share an
  // id by construction, so it is named once, with the synthesis id beside it.
  assert.equal(
    deepResearchModel({ decompose: 'M', gather: 'M', synth: 'H' }),
    'M (decompose, gather) + H (synth)',
  );
  // One id everywhere — an explicit `model`, or a catalog with a single
  // balanced entry — says it once rather than twice.
  assert.equal(deepResearchModel({ decompose: 'X', gather: 'X', synth: 'X' }), 'X');
  // Against the REAL catalog: exactly the pair stageModels picks, in that order.
  const s = stageModels(catalog);
  assert.equal(deepResearchModel(s), `${s.gather} (decompose, gather) + ${s.synth} (synth)`);
  assert.match(deepResearchModel(s), /Flash \(Medium\) \(decompose, gather\) \+ .*Flash \(High\) \(synth\)$/);
  // Half a pair is still an id; no id at all is not a report, and core/unit.mjs
  // ignores an empty string — the result stays filed under `(vendor default)`.
  assert.equal(deepResearchModel({ decompose: 'M', gather: 'M', synth: undefined }), 'M');
  assert.equal(deepResearchModel({ decompose: undefined, gather: undefined, synth: 'H' }), 'H');
  assert.equal(deepResearchModel({ decompose: undefined, gather: undefined, synth: undefined }), '');
  assert.equal(deepResearchModel({ decompose: '  ', gather: '  ', synth: '  ' }), '');
  assert.equal(deepResearchModel({}), '');
});

test('unit contract: four tools, billing scrub list, both modes declared', () => {
  assert.deepEqual(unit.tools.map((t) => t.name), ['gemini_research', 'gemini_image', 'gemini_models', 'gemini_deep_research']);
  assert.ok(unit.billingRiskEnv.includes('GEMINI_API_KEY') && unit.billingRiskEnv.includes('ANTHROPIC_API_KEY'));
  assert.deepEqual(unit.supportedModes, { 'read-only': true, 'workspace-write': true });
  assert.equal(catalog.efforts.length, 0);
});

test('runtime with a fake agy: argv per mode — research standard, workspace-write accept-edits, image always accept-edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-'));
  const fake = join(dir, 'fake-agy.mjs');
  writeFileSync(fake, 'process.stdout.write(JSON.stringify({status:"SUCCESS",response:"ARGS "+process.argv.slice(2).join(" ")+" CWD "+process.cwd()}))');
  const wrap = (env) => createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { model: catalog.ids[2], timeoutS: 120 } } }));
  const base = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };

  const ro = await wrap(base).callTool('gemini_research', { prompt: 'q' });
  assert.match(ro.text, /--output-format json/);
  assert.match(ro.text, /--print-timeout 120s/);
  assert.match(ro.text, new RegExp(`--model ${catalog.ids[2].replace(/[()]/g, '\\$&')}`));
  assert.doesNotMatch(ro.text, /--mode /);

  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { mode: 'workspace-write' } } }));
  const { utimesSync } = await import('node:fs');
  utimesSync(join(dir, 'fleet.config.json'), new Date(), new Date(Date.now() + 5000));
  const closed = await wrap(base).callTool('gemini_research', { prompt: 'q' });
  assert.doesNotMatch(closed.text, /--mode accept-edits/);
  const open = await wrap({ ...base, OMELETTE_ALLOW_WRITE: 'gemini' }).callTool('gemini_research', { prompt: 'q' });
  assert.match(open.text, /--mode accept-edits/);

  // Every spawn disables slash-command / skill expansion of the prompt text.
  assert.match(ro.text, /--disable-slash-commands/);

  // The image tool answers with the artifact path and NOTHING else (0.3.6), so
  // the run's argv and cwd are read off a log the fake writes rather than out
  // of the answer.
  const imgLog = join(dir, 'image-run.json');
  const imgFake = join(dir, 'fake-agy-image.mjs');
  writeFileSync(imgFake, [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `writeFileSync(${JSON.stringify(imgLog)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
    'const saved = join(process.cwd(), "img.png");',
    'writeFileSync(saved, "PNG");',
    'process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "Saved it to " + saved }));',
  ].join('\n'));
  const wrapImage = (e) => createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [imgFake, ...o.args] }) }) } : t)) },
    { env: e },
  );
  const img = await wrapImage(base).callTool('gemini_image', { prompt: 'a cat' });
  const imgRun = JSON.parse(readFileSync(imgLog, 'utf8'));
  const imgArgs = imgRun.args.join(' ');
  assert.match(imgArgs, /--mode accept-edits/);
  assert.match(imgArgs, /--disable-slash-commands/);
  // The prompt that actually reaches agy carries the "no shell" hardening: the
  // first live image call was lost to the model reaching for the `command`
  // tool, which headless agy auto-denies (2026-09-03).
  assert.match(imgArgs, /Use ONLY your built-in image generation tool and save the image directly with it\./);
  assert.match(imgArgs, /Do NOT run terminal commands — they are unavailable\./);
  // F8: the image run gets its OWN temp cwd, so even a cwd-relative save by agy
  // lands outside every project — never in whatever repo the server was started in.
  assert.ok(imgRun.cwd.startsWith(realpathSync(tmpdir())), `${imgRun.cwd} is not under ${realpathSync(tmpdir())}`);
  assert.match(imgRun.cwd, /omelette-gemini-image-/);
  assert.notEqual(imgRun.cwd, process.cwd());
  // The answer is the artifact on disk, not the prose that named it.
  assert.equal(img.text, join(imgRun.cwd, 'img.png'));
  // Research keeps the process cwd — only image runs are relocated.
  assert.match(ro.text, new RegExp(`CWD ${realpathSync(process.cwd())}$`));

  const noPrompt = await wrap(base).callTool('gemini_research', { prompt: '  ' });
  assert.equal(noPrompt.isError, true);
});

test('deep research under `cancel: kill`: a cancel stops the remaining gathers and the synthesis stage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-cancel-'));
  const fake = join(dir, 'fake-agy.mjs');
  // Decompose answers at once with two sub-questions; a gather would take 3 s.
  writeFileSync(fake, [
    'const argv = process.argv.slice(2);',
    'const prompt = argv[argv.indexOf("-p") + 1] || "";',
    'const say = (r) => process.stdout.write(JSON.stringify({ status: "SUCCESS", response: r }));',
    'if (/Decompose the following/.test(prompt)) say(JSON.stringify(["q one", "q two"]));',
    'else setTimeout(() => say("a finding"), 3000);',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { cancel: 'kill', timeoutS: 60 } } }));
  const base = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const controller = new AbortController();
  const spawns = [];
  const rt = createUnitRuntime(
    {
      ...unit,
      tools: unit.tools.map((t) => (t.run ? {
        ...t,
        run: (a, ctx) => t.run(a, {
          ...ctx,
          spawn: (o) => {
            spawns.push(o.args.join(' '));
            // The cancel lands exactly as the FIRST gather is issued: the second
            // gather and the synthesis must never reach a spawn at all.
            if (spawns.length === 2) controller.abort();
            return ctx.spawn({ ...o, args: [fake, ...o.args] });
          },
        }),
      } : t)),
    },
    { env: base },
  );
  const r = await rt.callTool('gemini_deep_research', { question: 'why' }, { id: 1, signal: controller.signal });
  assert.equal(spawns.length, 2, `decompose + one gather only, got: ${JSON.stringify(spawns.map((s) => s.slice(0, 40)))}`);
  assert.match(r.text, /Cancelled — the synthesis stage did not run/);
  assert.match(r.text, /_\(cancelled before this sub-question ran\)_/);
  const snap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'cancelled');
});

test('deep research under `cancel: kill`: a cancel DURING synthesis still returns the findings that were paid for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-cancel-synth-'));
  const fake = join(dir, 'fake-agy.mjs');
  // Every gather answers at once; only the synthesis is slow, so the cancel
  // lands inside the stage that has no salvage of its own.
  writeFileSync(fake, [
    'const argv = process.argv.slice(2);',
    'const prompt = argv[argv.indexOf("-p") + 1] || "";',
    'const say = (r) => process.stdout.write(JSON.stringify({ status: "SUCCESS", response: r }));',
    'if (/Decompose the following/.test(prompt)) say(JSON.stringify(["q one", "q two"]));',
    'else if (/Synthesize the research findings/.test(prompt)) setTimeout(() => say("a report"), 3000);',
    'else say("a finding");',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { cancel: 'kill', timeoutS: 60 } } }));
  const base = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const controller = new AbortController();
  const spawns = [];
  const rt = createUnitRuntime(
    {
      ...unit,
      tools: unit.tools.map((t) => (t.run ? {
        ...t,
        run: (a, ctx) => t.run(a, {
          ...ctx,
          spawn: (o) => {
            const args = o.args.join(' ');
            spawns.push(args);
            if (/Synthesize the research findings/.test(args)) controller.abort();
            return ctx.spawn({ ...o, args: [fake, ...o.args] });
          },
        }),
      } : t)),
    },
    { env: base },
  );
  const r = await rt.callTool('gemini_deep_research', { question: 'why' }, { id: 1, signal: controller.signal });
  assert.equal(spawns.length, 4, `decompose + two gathers + the synthesis, got ${spawns.length}`);
  assert.match(r.text, /Cancelled — the synthesis stage did not run/);
  // The point of the salvage: two gathers ran, were billed, and come back.
  assert.match(r.text, /### Sub-question 1: q one\n\na finding/);
  assert.match(r.text, /### Sub-question 2: q two\n\na finding/);
  assert.equal(r.isError, undefined, 'a cancelled run with findings is an answer, not an error');
  const snap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'cancelled');
  assert.equal(snap.lastEvent.partial, true);
});

test('deep research under `cancel: kill`: a synthesis KILLED MID-SENTENCE keeps the findings and marks its fragment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-cancel-frag-'));
  const fake = join(dir, 'fake-agy.mjs');
  const printed = join(dir, 'synthesis-printed');
  // The synthesis prints something and then hangs, so the cancel's SIGKILL
  // finds output to salvage: interpretAgy returns that fragment as a partial
  // answer and never throws, which is the path that used to drop the findings.
  //
  // The sentinel is written from the WRITE CALLBACK, which runs only once the
  // fragment has gone out to the pipe — so its existence is proof there is
  // something for the kill to salvage. A fixed delay would be a race the child
  // loses on a loaded machine.
  writeFileSync(fake, [
    'import { writeFileSync } from "node:fs";',
    `const PRINTED = ${JSON.stringify(printed)};`,
    'const argv = process.argv.slice(2);',
    'const prompt = argv[argv.indexOf("-p") + 1] || "";',
    'const say = (r) => process.stdout.write(JSON.stringify({ status: "SUCCESS", response: r }));',
    'if (/Decompose the following/.test(prompt)) say(JSON.stringify(["q one", "q two"]));',
    'else if (/Synthesize the research findings/.test(prompt)) {',
    '  process.stdout.write("half a report, cut off mid-", () => writeFileSync(PRINTED, "flushed"));',
    '  setTimeout(() => {}, 60000);',
    '} else say("a finding");',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { cancel: 'kill', timeoutS: 60 } } }));
  const base = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const controller = new AbortController();
  /** Abort as soon as the fragment is out — bounded, so a fake that never prints fails an assertion instead of hanging. */
  const abortOnFragment = async () => {
    const deadline = Date.now() + 20000;
    while (!existsSync(printed) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    controller.abort();
  };
  const rt = createUnitRuntime(
    {
      ...unit,
      tools: unit.tools.map((t) => (t.run ? {
        ...t,
        run: (a, ctx) => t.run(a, {
          ...ctx,
          spawn: (o) => {
            const running = ctx.spawn({ ...o, args: [fake, ...o.args] });
            // AFTER the spawn, and only once the child says it has printed:
            // aborting earlier would leave nothing to salvage.
            if (/Synthesize the research findings/.test(o.args.join(' '))) abortOnFragment();
            return running;
          },
        }),
      } : t)),
    },
    { env: base },
  );
  const r = await rt.callTool('gemini_deep_research', { question: 'why' }, { id: 1, signal: controller.signal });
  assert.equal(existsSync(printed), true, 'the fake agy never flushed its fragment — the run below proves nothing');
  assert.match(r.text, /Cancelled — the synthesis stage was cancelled before it finished/);
  assert.match(r.text, /### Sub-question 1: q one\n\na finding/, `findings dropped:\n${r.text}`);
  assert.match(r.text, /### Sub-question 2: q two\n\na finding/);
  // …and the fragment is kept, under a marker that says what it is.
  assert.match(r.text, /\[gemini: partial synthesis, cancelled\]/);
  assert.match(r.text, /half a report, cut off mid-/);
  assert.equal(r.isError, undefined);
  const snap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'cancelled');
  assert.equal(snap.lastEvent.partial, true);
});

// --- output cap, through the real spawn --------------------------------------

test('runtime with a fake agy: a capped run whose envelope survived is marked, a capped run whose envelope was cut open is refused and not retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-cap-'));
  const runs = join(dir, 'runs');
  const CAP = 160;
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const wrap = (fake) => createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { outputCap: CAP, timeoutS: 30 } } }));

  // The preamble is what the cap drops; the envelope is built to be EXACTLY CAP
  // characters long, so the tail keeps it whole and nothing else — the one shape
  // in which a capped agy run still parses.
  const fakeMarked = join(dir, 'fake-agy-cap.mjs');
  writeFileSync(fakeMarked, [
    'const base = JSON.stringify({ status: "SUCCESS", response: "" });',
    `const env = JSON.stringify({ status: "SUCCESS", response: "A".repeat(${CAP} - base.length) });`,
    'process.stdout.write("agy: starting up\\n".repeat(20) + env);',
  ].join('\n'));
  const marked = await wrap(fakeMarked).callTool('gemini_research', { prompt: 'q' });
  assert.ok(!marked.isError, marked.text);
  assert.match(marked.text, /^A+/);
  assert.match(marked.text, CAP_MARK(CAP));
  const snapshot = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snapshot.lastEvent.status, 'ok');
  assert.equal(snapshot.lastEvent.partial, true);

  // One envelope far longer than the cap: the tail is the middle of a JSON
  // object, which is not an answer however much text it contains.
  const fakeCut = join(dir, 'fake-agy-cut.mjs');
  writeFileSync(fakeCut, [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(runs)}, "x");`,
    'process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "z".repeat(400) }));',
  ].join('\n'));
  const cut = await wrap(fakeCut).callTool('gemini_research', { prompt: 'q' });
  assert.equal(cut.isError, true);
  assert.match(cut.text, new RegExp(`exceeded the ${CAP} char cap and the answer envelope was lost`));
  assert.equal(readFileSync(runs, 'utf8').length, 1, 'the run was not retried');
});

// --- deep research: partial stages -------------------------------------------

/** A finished-run shape in exactly the form core/spawn.mjs resolves one. */
const spawnRes = (over) => Promise.resolve({ stdout: '', stderr: '', code: 0, signal: null, killed: false, capped: false, ...over });

/**
 * A runtime whose spawn is answered in-process: no child, no timers, and every
 * stage of the pipeline chosen by the prompt it sends.
 */
const deepRt = (env, stub) => createUnitRuntime(
  { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: stub }) } : t)) },
  { env },
);

test('gemini_deep_research: a partial stage makes the whole report partial and says how many', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-deep-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  // The report IS the synthesis stage's answer, so the findings are only visible
  // in the prompt that stage was handed — which is where the failed gather's
  // line has to stand for a synthesis to work around it.
  let synthPrompt = '';
  const stub = (o) => {
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '{"subquestions":["alpha","beta"]}', structured_output: { subquestions: ['alpha', 'beta'] } }) });
    }
    // Hard-killed with text already in the envelope: salvaged, and partial.
    if (/Question: alpha$/.test(prompt)) return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: 'half of alpha' }), code: null, killed: true });
    // A stage that THREW — deterministic, so it is not even retried.
    if (/Question: beta$/.test(prompt)) return spawnRes({ stdout: '', stderr: 'RESOURCE_EXHAUSTED', code: 1 });
    synthPrompt = prompt;
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe report' }) });
  };
  const r = await deepRt(env, stub).callTool('gemini_deep_research', { question: 'the big question' });
  assert.ok(!r.isError, r.text);
  // decompose + 2 gathers + synthesis = 4 stages that ran; the killed gather is
  // the one partial ANSWER, and the failed one is a failure line, never a
  // partial stage — there is no half-answer to warn about.
  assert.match(r.text, /^\[gemini: 1 of 4 stages returned partial answers\]/);
  assert.match(synthPrompt, /_\(gather failed: Gemini quota exhausted/);
  assert.match(synthPrompt, /half of alpha/);
  assert.match(r.text, /## Summary/);
  const snapshot = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snapshot.lastEvent.status, 'ok');
  assert.equal(snapshot.lastEvent.partial, true);
});

test('gemini_deep_research: the partial line sits UNDER the degraded banner, and a clean run says neither', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-deep2-'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  // The decomposition is hard-killed with prose that carries no sub-questions:
  // the run degrades to a single pass AND that stage is partial.
  const degradedStub = (o) => {
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: 'no list here' }), code: null, killed: true });
    }
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nthe single-pass report' }) });
  };
  const degraded = await deepRt(env, degradedStub).callTool('gemini_deep_research', { question: 'the big question' });
  assert.ok(!degraded.isError, degraded.text);
  const paras = degraded.text.split('\n\n');
  assert.match(paras[0], /^> \*\*Degraded run — decomposition failed\.\*\*/);
  assert.equal(paras[1], '[gemini: 1 of 3 stages returned partial answers]');   // decompose + 1 gather + synthesis
  const degradedSnap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(degradedSnap.lastEvent.partial, true);

  // Every stage clean: no banner, no count line, no flag anywhere.
  const cleanStub = (o) => {
    const prompt = o.args[o.args.indexOf('-p') + 1];
    if (/Decompose the following research question/.test(prompt)) {
      return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '{"subquestions":["alpha"]}', structured_output: { subquestions: ['alpha'] } }) });
    }
    return spawnRes({ stdout: JSON.stringify({ status: 'SUCCESS', response: '## Summary\nall of it' }) });
  };
  const clean = await deepRt(env, cleanStub).callTool('gemini_deep_research', { question: 'the big question' });
  assert.equal(clean.text.startsWith('## Summary'), true, clean.text);
  assert.doesNotMatch(clean.text, /stages returned partial answers/);
  assert.doesNotMatch(clean.text, /Degraded run/);
  const cleanSnap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(cleanSnap.lastEvent.partial, undefined);   // absent, never false
});

// --- the model a spooled deep-research result is filed under (P2 · spec §4) --

/** The one spooled result in a throwaway fleet home, as a header. */
function onlySpooledHeader(dir) {
  const d = join(dir, 'results', 'gemini');
  const names = readdirSync(d).filter((n) => n.endsWith('.md'));
  assert.equal(names.length, 1, `expected exactly one spooled result in ${d}`);
  return parseResult(readFileSync(join(d, names[0]), 'utf8')).header;
}

/**
 * A fake `agy` that plays every stage of the pipeline: one sub-question out of
 * decompose, a finding out of a gather, a report out of the synthesis. Three
 * one-shots per deep-research call.
 */
function writeFakeDeepAgy(dir, name) {
  const fake = join(dir, name);
  writeFileSync(fake, [
    'const argv = process.argv.slice(2);',
    'const prompt = argv[argv.indexOf("-p") + 1] || "";',
    'const say = (r) => process.stdout.write(JSON.stringify({ status: "SUCCESS", response: r }));',
    'if (/Decompose the following/.test(prompt)) say(JSON.stringify({ subquestions: ["alpha"] }));',
    'else if (/Synthesize the research findings/.test(prompt)) say("## Summary\\nthe report");',
    'else say("a finding");',
  ].join('\n'));
  return fake;
}

/** The unit with every spawn routed through a fake binary, as elsewhere in this file. */
const wrapDeep = (env, fake) => createUnitRuntime(
  { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
  { env },
);

test('a spooled deep-research result names the stage models the run asked for — the composite, or the configured id', async () => {
  const scripts = mkdtempSync(join(tmpdir(), 'omelette-gemini-deepmodel-'));
  const fake = writeFakeDeepAgy(scripts, 'fake-deep-agy.mjs');
  const s = stageModels(catalog);
  const COMPOSITE = `${s.gather} (decompose, gather) + ${s.synth} (synth)`;

  // Nothing configured: the runtime resolved no model at all, so this record
  // used to read `(vendor default)` for a pipeline that had just picked two.
  const bare = mkdtempSync(join(tmpdir(), 'omelette-gemini-home-'));
  writeFileSync(join(bare, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const r = await wrapDeep({ ...process.env, OMELETTE_HOME: bare, AGY_BIN: process.execPath }, fake)
    .callTool('gemini_deep_research', { question: 'why' });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /## Summary/);
  assert.equal(onlySpooledHeader(bare).model, COMPOSITE);
  // The status feed is NOT a second place this is reported: it still records
  // what the runtime resolved, which here is nothing at all.
  const snap = JSON.parse(readFileSync(join(bare, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'ok');
  assert.equal(snap.lastEvent.model, undefined);

  // A configured model: stageModels gives every stage that id, the composite
  // collapses to it, and the runtime's own value outranks the report anyway.
  const cfg = mkdtempSync(join(tmpdir(), 'omelette-gemini-home-'));
  writeFileSync(join(cfg, 'fleet.config.json'), JSON.stringify({ units: { gemini: { model: catalog.ids[3], timeoutS: 30 } } }));
  const r2 = await wrapDeep({ ...process.env, OMELETTE_HOME: cfg, AGY_BIN: process.execPath }, fake)
    .callTool('gemini_deep_research', { question: 'why' });
  assert.ok(!r2.isError, r2.text);
  const configured = onlySpooledHeader(cfg);
  assert.equal(configured.model, catalog.ids[3]);
  assert.doesNotMatch(configured.model, /\(decompose, gather\)/);

  // An explicit `model` argument: same answer, through the argument.
  const asked = mkdtempSync(join(tmpdir(), 'omelette-gemini-home-'));
  writeFileSync(join(asked, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const r3 = await wrapDeep({ ...process.env, OMELETTE_HOME: asked, AGY_BIN: process.execPath }, fake)
    .callTool('gemini_deep_research', { question: 'why', model: catalog.ids[4] });
  assert.ok(!r3.isError, r3.text);
  assert.equal(onlySpooledHeader(asked).model, catalog.ids[4]);

  // …and gemini_research still reports nothing: agy picks the model and never
  // says which, so `(vendor default)` stays the honest header for that tool.
  const plain = mkdtempSync(join(tmpdir(), 'omelette-gemini-home-'));
  writeFileSync(join(plain, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const r4 = await wrapDeep({ ...process.env, OMELETTE_HOME: plain, AGY_BIN: process.execPath }, fake)
    .callTool('gemini_research', { prompt: 'q' });
  assert.ok(!r4.isError, r4.text);
  assert.equal(onlySpooledHeader(plain).model, '(vendor default)');
});

test('a deep-research run that is cancelled or capped is still filed under the stage models it asked for', async () => {
  const s = stageModels(catalog);
  const COMPOSITE = `${s.gather} (decompose, gather) + ${s.synth} (synth)`;

  // (1) CANCELLED as the first gather is issued. The report happened before
  // the decompose spawn, so the record names both stage models even though the
  // synthesis never ran and the answer is the raw findings.
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-deepcancel-'));
  const fake = join(dir, 'fake-agy.mjs');
  writeFileSync(fake, [
    'const argv = process.argv.slice(2);',
    'const prompt = argv[argv.indexOf("-p") + 1] || "";',
    'const say = (r) => process.stdout.write(JSON.stringify({ status: "SUCCESS", response: r }));',
    'if (/Decompose the following/.test(prompt)) say(JSON.stringify(["q one", "q two"]));',
    'else setTimeout(() => say("a finding"), 3000);',
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { cancel: 'kill', timeoutS: 60 } } }));
  const controller = new AbortController();
  let spawns = 0;
  const rt = createUnitRuntime(
    {
      ...unit,
      tools: unit.tools.map((t) => (t.run ? {
        ...t,
        run: (a, ctx) => t.run(a, {
          ...ctx,
          spawn: (o) => {
            if (++spawns === 2) controller.abort();   // the cancel lands on the first gather
            return ctx.spawn({ ...o, args: [fake, ...o.args] });
          },
        }),
      } : t)),
    },
    { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath } },
  );
  const r = await rt.callTool('gemini_deep_research', { question: 'why' }, { id: 1, signal: controller.signal });
  assert.match(r.text, /Cancelled — the synthesis stage did not run/);
  const cancelled = onlySpooledHeader(dir);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.model, COMPOSITE);

  // (2) CAPPED on the very first stage: the decompose envelope is cut open, the
  // throw is deterministic so nothing is retried, and the failed call is
  // spooled — under the same two ids, which is the point of reporting early.
  const cut = mkdtempSync(join(tmpdir(), 'omelette-gemini-deepcap-'));
  const fakeCut = join(cut, 'fake-agy-cut.mjs');
  writeFileSync(fakeCut, 'process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "z".repeat(400) }))');
  writeFileSync(join(cut, 'fleet.config.json'), JSON.stringify({ units: { gemini: { outputCap: 160, timeoutS: 30 } } }));
  const capped = await wrapDeep({ ...process.env, OMELETTE_HOME: cut, AGY_BIN: process.execPath }, fakeCut)
    .callTool('gemini_deep_research', { question: 'why' });
  assert.equal(capped.isError, true);
  assert.match(capped.text, /exceeded the 160 char cap and the answer envelope was lost/);
  const header = onlySpooledHeader(cut);
  assert.equal(header.status, 'error');
  assert.equal(header.model, COMPOSITE);
});

test('gemini_research: an absolute `cwd` is where the run happens (agy has no cwd flag); a bad one is refused before any spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-cwd-'));
  const where = mkdtempSync(join(tmpdir(), 'omelette-gemini-where-'));
  const fake = join(dir, 'fake-agy-cwd.mjs');
  writeFileSync(fake, 'process.stdout.write(JSON.stringify({ status: "SUCCESS", response: "CWD " + process.cwd() }))');
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  const env = { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath };
  const rt = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env },
  );
  assert.equal((await rt.callTool('gemini_research', { prompt: 'q', cwd: where })).text, `CWD ${realpathSync(where)}`);
  assert.equal((await rt.callTool('gemini_research', { prompt: 'q' })).text, `CWD ${realpathSync(process.cwd())}`);
  const rel = await rt.callTool('gemini_research', { prompt: 'q', cwd: 'relative/path' });
  assert.equal(rel.isError, true);
  assert.match(rel.text, /"cwd" must be an absolute path \(got "relative\/path"\)/);
  const missing = await rt.callTool('gemini_research', { prompt: 'q', cwd: join(dir, 'no-such-dir') });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /"cwd" is not an existing directory/);
  const spool = join(dir, 'results', 'gemini');
  const bodies = readdirSync(spool).filter((f) => f.endsWith('.md')).map((f) => readFileSync(join(spool, f), 'utf8'));
  assert.ok(bodies.some((b) => b.includes(`\ncwd: ${where}\n`)), bodies.join('\n---\n'));
});

test('gemini_image: a capped run whose artifact is on disk answers with the BARE path and flags partial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-img-cap-'));
  const saved = join(dir, 'generated.png');
  // agy prints ONE envelope. The cap is set to exactly its length, so the
  // preamble ahead of it is dropped and the envelope itself still parses —
  // the one capped shape that comes back as an answer rather than an error.
  const envelopeText = JSON.stringify({ status: 'SUCCESS', response: `Saved it to ${saved}` });
  const fake = join(dir, 'fake-agy-img-cap.mjs');
  // The RUN saves the file: an image older than the run is not its artifact.
  writeFileSync(fake, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(saved)}, "PNG");`,
    `process.stdout.write("n".repeat(500) + ${JSON.stringify(envelopeText)});`,
  ].join('\n'));
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { outputCap: envelopeText.length, timeoutS: 30 } } }));
  const rt = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath } },
  );
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(r.text, saved);   // the path, alone: no cap marker on a string to stat
  const snap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'ok');
  assert.equal(snap.lastEvent.partial, true);
});

test('gemini_image: a capped run with no file on disk is an error naming gemini.outputCap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-img-nofile-'));
  const envelopeText = JSON.stringify({ status: 'SUCCESS', response: `Saved it to ${join(dir, 'imagined.png')}` });
  const fake = join(dir, 'fake-agy-img-nofile.mjs');
  writeFileSync(fake, `process.stdout.write("n".repeat(500) + ${JSON.stringify(envelopeText)});`);
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { outputCap: envelopeText.length, timeoutS: 30 } } }));
  const rt = createUnitRuntime(
    { ...unit, tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args] }) }) } : t)) },
    { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath } },
  );
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(r.isError, true);
  assert.match(r.text, new RegExp(`gemini_image finished without a saved image on disk \\(temp dir \\S+; the run's output exceeded the ${envelopeText.length} char cap — raise gemini\\.outputCap or narrow the task\\)`));
  assert.match(r.text, /Raw output: /);
});

/**
 * gemini_image with a REAL fake process. A fake that hangs is hard-killed on
 * the spawn's own bound: agy's process-group kill sits 60 s ABOVE the timeout
 * it is handed (HARD_KILL_GRACE_MS) and no unit test waits a minute, so the
 * kill is brought forward by overriding `hardKillMs` on the spawn — the config
 * keeps `timeoutS: 1`, which is what the messages quote. A fake that exits on
 * its own never reaches it.
 * @param {string} dir the fleet home · @param {string} body the fake's script
 */
function imageRuntime(dir, body, over = {}) {
  const fake = join(dir, 'fake-agy-img.mjs');
  writeFileSync(fake, body);
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 1, ...over } } }));
  return createUnitRuntime(
    {
      ...unit,
      tools: unit.tools.map((t) => (t.run ? {
        ...t,
        run: (a, ctx) => t.run(a, { ...ctx, spawn: (o) => ctx.spawn({ ...o, args: [fake, ...o.args], hardKillMs: 1000 }) }),
      } : t)),
    },
    { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath } },
  );
}

/** A fake that saves `img.png` in its own cwd, then does `after`. */
const savesThen = (after) => [
  'import { writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'writeFileSync(join(process.cwd(), "img.png"), "PNG");',
  after,
].join('\n');

test('gemini_image: a run hard-killed with EMPTY stdout answers with the file it had already saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-img-killed-empty-'));
  // Nothing on stdout at all: interpretAgy THROWS ("hard-killed after 61s"),
  // and the file in the run's own temp directory outranks that refusal.
  const rt = imageRuntime(dir, savesThen('setTimeout(() => {}, 30000);'));
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /omelette-gemini-image-\S+[/\\]img\.png$/, r.text);
  assert.equal(existsSync(r.text), true, r.text);
  const snap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.partial, true);
});

test('gemini_image: a run that saved the file and then said NOTHING answers with the file, flagged partial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-img-silent-'));
  // Exit 0, no stdout, no stderr: interpretAgy returns an empty answer, which
  // is no answer at all — the artifact on disk is what the tool promised.
  const rt = imageRuntime(dir, savesThen('process.exit(0);'));
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /omelette-gemini-image-\S+[/\\]img\.png$/, r.text);
  const snap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.partial, true);
});

test('gemini_image: a file saved in a SUBDIRECTORY of the run cwd is still the artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-img-nested-'));
  // agy chooses the name AND the directory: live it saves `generated/image.png`
  // under the run's cwd. Hard-killed with empty stdout, so the only place the
  // artifact can come from is the scan of the run's own directory.
  const rt = imageRuntime(dir, [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'mkdirSync(join(process.cwd(), "generated"), { recursive: true });',
    'writeFileSync(join(process.cwd(), "generated", "image.png"), "PNG");',
    'setTimeout(() => {}, 30000);',
  ].join('\n'));
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /omelette-gemini-image-\S+[/\\]generated[/\\]image\.png$/, r.text);
  assert.equal(existsSync(r.text), true, r.text);
  const snap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.partial, true);
});

test('gemini_image: a capped run whose envelope was cut open answers with the file it saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-img-cut-'));
  // The cap keeps the TAIL, so the envelope no longer parses and interpretAgy
  // refuses the run (`gemini.outputCap`). The file was saved before that.
  const rt = imageRuntime(
    dir,
    savesThen('process.stdout.write("n".repeat(500) + JSON.stringify({ status: "SUCCESS", response: "Saved it" }));'),
    { outputCap: 40 },
  );
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /omelette-gemini-image-\S+[/\\]img\.png$/, r.text);
  const snap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.partial, true);
});

test('gemini_image: an artifact from a run agy did not finish cleanly is flagged partial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-img-timeout-'));
  // Exit 0, an answer, and agy reporting a run that ended early: neither bound
  // of ours was reached, so nothing marks it partial except the status itself
  // — and an artifact from a run that did not finish is a partial answer.
  const rt = imageRuntime(dir, savesThen([
    'process.stdout.write(JSON.stringify({ status: "TIMEOUT", response: "Saved it to " + join(process.cwd(), "img.png") }));',
    'process.exit(0);',
  ].join('\n')));
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(r.isError, undefined, r.text);
  assert.match(r.text, /omelette-gemini-image-\S+[/\\]img\.png$/, r.text);
  assert.doesNotMatch(r.text, /TIMEOUT|status/);   // the bare path, still
  const snap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.partial, true);
});

test('gemini_image: a killed run that saved NOTHING is still an error naming gemini.timeoutS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-img-killed-nofile-'));
  const rt = imageRuntime(dir, 'setTimeout(() => {}, 30000);');
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /gemini\.timeoutS/, r.text);
});

test('gemini_image: a hard-killed run whose file is already on disk answers with the bare path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omelette-gemini-img-kill-'));
  const saved = join(dir, 'generated.png');
  writeFileSync(join(dir, 'fleet.config.json'), JSON.stringify({ units: { gemini: { timeoutS: 30 } } }));
  // A REAL hard kill would cost agy's own grace: the process-group SIGKILL
  // sits 60 s ABOVE the timeout it is handed (HARD_KILL_GRACE_MS), and no unit
  // test waits a minute. So the killed run is handed to the adapter directly —
  // what is under test is the image tool's reading of one, not
  // core/spawn.mjs's kill, which has its own tests.
  const killed = {
    stdout: JSON.stringify({ status: 'SUCCESS', response: `Saved it to ${saved}` }),
    stderr: '', code: null, signal: 'SIGKILL', killed: true, capped: false, cancelled: false,
  };
  const rt = createUnitRuntime(
    {
      ...unit,
      // The file appears WHILE the run is going, as a real one does: the
      // artifact is dated by the run that wrote it (core/artifact.mjs).
      tools: unit.tools.map((t) => (t.run ? { ...t, run: (a, ctx) => t.run(a, { ...ctx, spawn: async () => { writeFileSync(saved, 'PNG'); return killed; } }) } : t)),
    },
    { env: { ...process.env, OMELETTE_HOME: dir, AGY_BIN: process.execPath } },
  );
  const r = await rt.callTool('gemini_image', { prompt: 'a cat' });
  assert.equal(r.isError, undefined, r.text);
  assert.equal(r.text, saved);   // no kill marker rides a path
  const snap = JSON.parse(readFileSync(join(dir, 'status-gemini.json'), 'utf8'));
  assert.equal(snap.lastEvent.status, 'ok');
  assert.equal(snap.lastEvent.partial, true);
});
