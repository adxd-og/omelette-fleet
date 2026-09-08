import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import unit, { interpretAgy, parseSubquestions, stageModels, catalog } from '../units/gemini/adapter.mjs';
import { createUnitRuntime } from '../core/unit.mjs';

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

  const img = await wrap(base).callTool('gemini_image', { prompt: 'a cat' });
  assert.match(img.text, /--mode accept-edits/);
  assert.match(img.text, /--disable-slash-commands/);
  // The prompt that actually reaches agy carries the "no shell" hardening: the
  // first live image call was lost to the model reaching for the `command`
  // tool, which headless agy auto-denies (2026-09-03).
  assert.match(img.text, /Use ONLY your built-in image generation tool and save the image directly with it\./);
  assert.match(img.text, /Do NOT run terminal commands — they are unavailable\./);
  // F8: the image run gets its OWN temp cwd, so even a cwd-relative save by agy
  // lands outside every project — never in whatever repo the server was started in.
  const imgCwd = /CWD (.+)$/.exec(img.text)[1];
  assert.ok(imgCwd.startsWith(realpathSync(tmpdir())), `${imgCwd} is not under ${realpathSync(tmpdir())}`);
  assert.match(imgCwd, /omelette-gemini-image-/);
  assert.notEqual(imgCwd, process.cwd());
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
