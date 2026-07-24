#!/usr/bin/env node
/**
 * Differential parser fuzzer (issue #43, Part 2).
 *
 * Seeded, DETERMINISTIC mutation fuzzer that feeds mutated corpus XML to BOTH
 * engines -- the air-ts parser (packages/air-ts, in-process) and the Python
 * oracle (`air fuzz-eval --batch`, one long-lived subprocess) -- and asserts
 * their outcomes MATCH exactly.
 *
 * Mutator inventory (MUTATORS below): element duplicate/delete/swap/reparent,
 * attribute mutate/drop, pin-alias substitution (net/node/ref), numeric-id
 * rename (integer-like ids that expose JS integer-key iteration order vs Python
 * dict insertion order -- the #79 divergence class), value-string mutation with
 * unit suffixes, comment/CDATA injection, random unicode, and truncation.
 * Their outcomes MATCH means:
 *
 *   - same accept/reject decision, AND
 *   - same rejection class (the registered SEC- code set, order-insensitive) on
 *     reject, AND
 *   - byte-equal model hash on accept.
 *
 * Any CRASH (status "crash", i.e. an unhandled exception) in EITHER engine is a
 * failure regardless of agreement -- "both crash" is still a failure (issue #43
 * guardrail).
 *
 * Determinism: a seeded PRNG (mulberry32) drives every choice. `--seed S` twice
 * produces byte-identical case sequences, so PR CI is reproducible. No wall
 * clock, no Math.random, no Date.
 *
 * KNOWN-divergence classifier: findings matching a DISCLOSED/FILED divergence
 * family (#75 undefined-entity / malformed-ref handling; #76 attribute
 * whitespace normalization; #78 well-formedness gaps) are reported as KNOWN
 * (counted per family), NOT as failures. The classifier is NARROW and CAUSALLY
 * GATED: it keys off the mismatch KIND (a decision mismatch can only be #75/#78;
 * a hash mismatch can only be #76, and only when whitespace re-normalization
 * CONFIRMS the divergence is exactly the normalization difference), never on a
 * document-global property (the round-1 verifier finding: a stray CR must not
 * flip an unrelated divergence to KNOWN). It is self-tested (`--self-test`),
 * including the verifier's form-feed + CR flip experiment. A NEW divergence (no
 * family match) fails the run and is auto-shrunk to a minimal reproducer. #80
 * (multiple <setup>) was FIXED upstream and is NO LONGER a suppression family.
 *
 * Usage:
 *   node scripts/fuzz_diff.mjs --seed 1 --cases 1000
 *   node scripts/fuzz_diff.mjs --self-test
 *   node scripts/fuzz_diff.mjs --seed 7 --cases 50000 --emit-regressions
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CORPUS_DIR = join(REPO_ROOT, "tests", "golden_corpus");
const AIRTS_DIST = join(REPO_ROOT, "packages", "air-ts", "dist", "index.js");
const REGRESSION_DIR = join(REPO_ROOT, "tests", "fuzz_regressions");
const PYTHON = process.env.AIR_FUZZ_PYTHON ||
  join(REPO_ROOT, ".venv", "Scripts", "python.exe");
const CORE_SRC = join(REPO_ROOT, "packages", "core", "src");

// --------------------------------------------------------------------------- //
// Seeded PRNG (mulberry32): tiny, fast, deterministic, dependency-free.
// --------------------------------------------------------------------------- //

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). */
const randInt = (rng, n) => Math.floor(rng() * n);
/** Uniform pick from a non-empty array. */
const pick = (rng, arr) => arr[randInt(rng, arr.length)];

// --------------------------------------------------------------------------- //
// A minimal, robust XML tokenizer. We do NOT build a DOM: mutations operate on
// the token stream + raw text, which is exactly what makes them adversarial
// (they can produce malformed XML, which the fuzzer WANTS -- both engines must
// then agree on the rejection). Tokens: "open" (<tag ...>), "close" (</tag>),
// "selfclose" (<tag/>), "text", "comment", "cdata", "pi".
// --------------------------------------------------------------------------- //

function tokenize(xml) {
  const tokens = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    if (xml[i] === "<") {
      if (xml.startsWith("<!--", i)) {
        const end = xml.indexOf("-->", i);
        const stop = end === -1 ? n : end + 3;
        tokens.push({ kind: "comment", raw: xml.slice(i, stop) });
        i = stop;
      } else if (xml.startsWith("<![CDATA[", i)) {
        const end = xml.indexOf("]]>", i);
        const stop = end === -1 ? n : end + 3;
        tokens.push({ kind: "cdata", raw: xml.slice(i, stop) });
        i = stop;
      } else if (xml.startsWith("<?", i)) {
        const end = xml.indexOf("?>", i);
        const stop = end === -1 ? n : end + 2;
        tokens.push({ kind: "pi", raw: xml.slice(i, stop) });
        i = stop;
      } else {
        const end = xml.indexOf(">", i);
        const stop = end === -1 ? n : end + 1;
        const raw = xml.slice(i, stop);
        let kind = "open";
        if (raw.startsWith("</")) kind = "close";
        else if (raw.endsWith("/>")) kind = "selfclose";
        tokens.push({ kind, raw, tag: tagNameOf(raw) });
        i = stop;
      }
    } else {
      const end = xml.indexOf("<", i);
      const stop = end === -1 ? n : end;
      tokens.push({ kind: "text", raw: xml.slice(i, stop) });
      i = stop;
    }
  }
  return tokens;
}

function tagNameOf(raw) {
  const m = /^<\/?\s*([A-Za-z_][\w.-]*)/.exec(raw);
  return m ? m[1] : "";
}

const serialize = (tokens) => tokens.map((t) => t.raw).join("");

// --------------------------------------------------------------------------- //
// Mutators. Each takes (tokens, rng) and returns a NEW token array (or the same
// reference if it could not apply). The driver picks one per case; the mutated
// input is deliberately allowed to be malformed.
// --------------------------------------------------------------------------- //

const PIN_ALIASES = ["net", "node", "ref"];
const UNIT_SUFFIXES = ["", "k", "m", "u", "n", "p", "M", "G", "meg", "Ohm", "V", "A", "F", "Hz", "%", "xyz"];
const RANDOM_UNICODE = ["é", " ", "中", "\u{1f600}", "́", "�", "\t", "\r", "\n"];
const NAMED_ENTITIES = ["&nbsp;", "&foo;", "&copy;", "&amp;", "&#65;", "&#x42;", "&#X42;", "&#;", "&"];

function indicesOf(tokens, pred) {
  const out = [];
  for (let k = 0; k < tokens.length; k++) if (pred(tokens[k])) out.push(k);
  return out;
}

/** Duplicate a random element (open..matching close, or a self-close). */
function mutElementDuplicate(tokens, rng) {
  const opens = indicesOf(tokens, (t) => t.kind === "open" || t.kind === "selfclose");
  if (!opens.length) return tokens;
  const start = pick(rng, opens);
  const end = tokens[start].kind === "selfclose" ? start : matchingClose(tokens, start);
  if (end === -1) return tokens;
  const slice = tokens.slice(start, end + 1);
  return tokens.slice(0, end + 1).concat(slice, tokens.slice(end + 1));
}

/** Delete a random element subtree. */
function mutElementDelete(tokens, rng) {
  const opens = indicesOf(tokens, (t) => t.kind === "open" || t.kind === "selfclose");
  if (opens.length <= 1) return tokens;
  const start = pick(rng, opens);
  const end = tokens[start].kind === "selfclose" ? start : matchingClose(tokens, start);
  if (end === -1) return tokens;
  return tokens.slice(0, start).concat(tokens.slice(end + 1));
}

/** Swap two sibling-ish element tokens (structural shuffle). */
function mutElementSwap(tokens, rng) {
  const opens = indicesOf(tokens, (t) => t.kind === "open" || t.kind === "selfclose" || t.kind === "close");
  if (opens.length < 2) return tokens;
  const a = pick(rng, opens);
  const b = pick(rng, opens);
  if (a === b) return tokens;
  const copy = tokens.slice();
  const tmp = copy[a];
  copy[a] = copy[b];
  copy[b] = tmp;
  return copy;
}

/** Reparent: move a close tag earlier/later (breaks nesting deliberately). */
function mutElementReparent(tokens, rng) {
  const closes = indicesOf(tokens, (t) => t.kind === "close");
  if (!closes.length) return tokens;
  const from = pick(rng, closes);
  const copy = tokens.slice();
  const [tok] = copy.splice(from, 1);
  const to = randInt(rng, copy.length + 1);
  copy.splice(to, 0, tok);
  return copy;
}

/** Mutate an attribute value (append unit suffix / unicode / entity / empty). */
function mutAttributeMutate(tokens, rng) {
  const opens = indicesOf(tokens, (t) => t.kind === "open" || t.kind === "selfclose");
  if (!opens.length) return tokens;
  const idx = pick(rng, opens);
  const raw = tokens[idx].raw;
  const attrs = [...raw.matchAll(/(\s[A-Za-z_][\w.:-]*\s*=\s*)(["'])(.*?)\2/g)];
  if (!attrs.length) return tokens;
  const target = pick(rng, attrs);
  const mode = randInt(rng, 5);
  let newVal;
  if (mode === 0) newVal = target[3] + pick(rng, UNIT_SUFFIXES);
  else if (mode === 1) newVal = target[3] + pick(rng, RANDOM_UNICODE);
  else if (mode === 2) newVal = target[3] + pick(rng, NAMED_ENTITIES);
  else if (mode === 3) newVal = "";
  else newVal = String(randInt(rng, 1_000_000)) + pick(rng, UNIT_SUFFIXES);
  const replaced = target[1] + target[2] + newVal + target[2];
  const copy = tokens.slice();
  copy[idx] = { ...tokens[idx], raw: raw.replace(target[0], replaced) };
  return copy;
}

/** Drop a random attribute from an element. */
function mutAttributeDrop(tokens, rng) {
  const opens = indicesOf(tokens, (t) => t.kind === "open" || t.kind === "selfclose");
  if (!opens.length) return tokens;
  const idx = pick(rng, opens);
  const raw = tokens[idx].raw;
  const attrs = [...raw.matchAll(/\s[A-Za-z_][\w.:-]*\s*=\s*(["']).*?\1/g)];
  if (!attrs.length) return tokens;
  const target = pick(rng, attrs);
  const copy = tokens.slice();
  copy[idx] = { ...tokens[idx], raw: raw.replace(target[0], "") };
  return copy;
}

/** Substitute a pin alias key (net= <-> node= <-> ref=). Exercises leniency. */
function mutPinAliasSubstitution(tokens, rng) {
  const opens = indicesOf(
    tokens,
    (t) => (t.kind === "open" || t.kind === "selfclose") && /\b(net|node|ref)\s*=/.test(t.raw),
  );
  if (!opens.length) return tokens;
  const idx = pick(rng, opens);
  const raw = tokens[idx].raw;
  const from = pick(rng, PIN_ALIASES);
  const to = pick(rng, PIN_ALIASES);
  const re = new RegExp("\\b" + from + "(\\s*=)");
  if (!re.test(raw)) return tokens;
  const copy = tokens.slice();
  copy[idx] = { ...tokens[idx], raw: raw.replace(re, to + "$1") };
  return copy;
}

/** Mutate a value string in element text with unit suffixes. */
function mutValueString(tokens, rng) {
  const texts = indicesOf(tokens, (t) => t.kind === "text" && t.raw.trim().length > 0);
  if (!texts.length) return tokens;
  const idx = pick(rng, texts);
  const copy = tokens.slice();
  const suffix = pick(rng, UNIT_SUFFIXES);
  copy[idx] = { ...tokens[idx], raw: tokens[idx].raw.trim() + suffix };
  return copy;
}

/** Inject a comment at a random position. */
function mutCommentInjection(tokens, rng) {
  const copy = tokens.slice();
  const at = randInt(rng, copy.length + 1);
  copy.splice(at, 0, { kind: "comment", raw: "<!-- " + pick(rng, ["x", "&#8;", "-->broken", "a--b"]) + " -->" });
  return copy;
}

/** Inject a CDATA section into element content. */
function mutCdataInjection(tokens, rng) {
  const copy = tokens.slice();
  const at = randInt(rng, copy.length + 1);
  copy.splice(at, 0, { kind: "cdata", raw: "<![CDATA[" + pick(rng, ["x<y&z", "&#8;", "]]", "&amp;"]) + "]]>" });
  return copy;
}

/** Insert random unicode into a text or attribute value. */
function mutRandomUnicode(tokens, rng) {
  const idxs = indicesOf(tokens, (t) => t.kind === "text");
  if (!idxs.length) return tokens;
  const idx = pick(rng, idxs);
  const copy = tokens.slice();
  const s = tokens[idx].raw;
  const at = randInt(rng, s.length + 1);
  copy[idx] = { ...tokens[idx], raw: s.slice(0, at) + pick(rng, RANDOM_UNICODE) + s.slice(at) };
  return copy;
}

// Integer-like id/name values that expose JS integer-key iteration order (an
// object with keys "1","2","10" iterates NUMERICALLY-first in JS but preserves
// insertion order in a Python dict). #79 showed this is a divergence-rich input
// class (5 parser/validation divergences, incl. silently-missing diagnostics),
// so the fuzzer must hammer it forever. Values include pure ints, an int with a
// leading zero ("007"), a hex-looking string, and a large int.
const NUMERIC_IDS = ["1", "2", "10", "3", "007", "0x1", "42", "100", "9", "0"];

/**
 * Rename id/name attribute values to numeric / integer-like strings, and mix
 * numeric with alpha ids in one design. Rewrites SEVERAL id/name values so a
 * single design ends up with keys like {"10","2","alpha","1"} -- exactly the
 * shape whose object-key iteration order diverges between JS and Python
 * (guards the #79 class permanently).
 */
function mutNumericIdRename(tokens, rng) {
  const opens = indicesOf(
    tokens,
    (t) => (t.kind === "open" || t.kind === "selfclose") && /\b(?:id|name)\s*=/.test(t.raw),
  );
  if (!opens.length) return tokens;
  const copy = tokens.slice();
  // Rewrite a random-but->=1 subset so the design mixes several numeric ids.
  const count = 1 + randInt(rng, opens.length);
  const chosen = new Set();
  for (let k = 0; k < count; k++) chosen.add(pick(rng, opens));
  for (const idx of chosen) {
    const raw = copy[idx].raw;
    // Replace the FIRST id/name value; occasionally leave one alpha to force a
    // mixed numeric+alpha key set within the parent collection.
    const keepAlpha = rng() < 0.25;
    if (keepAlpha) continue;
    const replaced = raw.replace(
      /\b(id|name)(\s*=\s*)(["'])(.*?)\3/,
      (_m, key, eq, q) => `${key}${eq}${q}${pick(rng, NUMERIC_IDS)}${q}`,
    );
    copy[idx] = { ...copy[idx], raw: replaced };
  }
  return copy;
}

/** Truncate the document at a random point (produces malformed XML). */
function mutTruncation(tokens, rng) {
  if (tokens.length < 2) return tokens;
  const keep = 1 + randInt(rng, tokens.length - 1);
  return tokens.slice(0, keep);
}

const MUTATORS = [
  ["element-duplicate", mutElementDuplicate],
  ["element-delete", mutElementDelete],
  ["element-swap", mutElementSwap],
  ["element-reparent", mutElementReparent],
  ["attribute-mutate", mutAttributeMutate],
  ["attribute-drop", mutAttributeDrop],
  ["pin-alias-substitution", mutPinAliasSubstitution],
  ["numeric-id-rename", mutNumericIdRename],
  ["value-string", mutValueString],
  ["comment-injection", mutCommentInjection],
  ["cdata-injection", mutCdataInjection],
  ["random-unicode", mutRandomUnicode],
  ["truncation", mutTruncation],
];

/** Find the index of the close tag that matches the open at `start`. */
function matchingClose(tokens, start) {
  let depth = 0;
  for (let k = start; k < tokens.length; k++) {
    if (tokens[k].kind === "open") depth++;
    else if (tokens[k].kind === "close") {
      depth--;
      if (depth === 0) return k;
    } else if (tokens[k].kind === "selfclose" && k === start) {
      return k;
    }
  }
  return -1;
}

/** Apply 1..maxOps mutators to a base design, returning the mutated XML. */
function mutate(baseXml, rng, maxOps = 3) {
  let tokens = tokenize(baseXml);
  const ops = 1 + randInt(rng, maxOps);
  const applied = [];
  for (let o = 0; o < ops; o++) {
    const [name, fn] = pick(rng, MUTATORS);
    tokens = fn(tokens, rng);
    applied.push(name);
  }
  return { xml: serialize(tokens), applied };
}

// --------------------------------------------------------------------------- //
// KNOWN-divergence classifier. NARROW and CAUSALLY GATED by construction: a
// divergence is KNOWN only when (a) its mismatch KIND matches the family's
// phenomenology AND (b) the input carries the family's specific structural
// fingerprint. It never suppresses on the basis of "the outcomes differ" alone,
// and -- the verifier's round-1 finding -- it never suppresses on a
// DOCUMENT-GLOBAL property.
//
//   #78  well-formedness gaps (DECISION mismatch): fast-xml-parser accepts
//        constructs expat rejects as "not well-formed" -- a comment whose
//        content contains "--" (or ends "--->"), a '<' literal inside an
//        attribute value, and the reserved 'xml' PI target. FOUND BY THIS FUZZER
//        (seed 1), FILED as #78, shrunk fixtures under tests/fuzz_regressions/.
//
// #75 (undefined named entities / malformed reference syntax) and #76
// (attribute-value + CR whitespace normalization) were FIXED in air-ts's XML
// layer (packages/air-ts/src/xml.ts: rejectBadReferences + normalizeXmlWhitespace
// reproduce expat's decisions), so they NO LONGER diverge and their suppression
// families were REMOVED here -- were either to reappear (a reverted fix) it would
// correctly classify NEW and FAIL the campaign, instead of being masked. Their
// regression fixtures flipped from `diverge-known` to agreement guards
// (diff_75_* -> reject-agree, diff_76_* -> accept-agree), like agree_80.
//
// #80 (multiple <setup> blocks) was likewise FIXED upstream (PR #79 / issue #8:
// air-ts parser.ts now iterates findAll(test,"setup") like the oracle), so it no
// longer diverges and is NOT a KNOWN-suppression family. Its regression fixture
// is kept as an AGREEMENT guard (agree_80_multiple_setup).
// --------------------------------------------------------------------------- //

function has78Fingerprint(xml) {
  // (a) a comment whose CONTENT contains "--" (illegal per XML 1.0) or ends
  //     with a hyphen immediately before the "-->" terminator ("--->").
  for (const m of xml.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (m[1].includes("--") || m[1].endsWith("-")) return true;
  }
  // A comment that never terminates (fast-xml-parser tolerates, expat rejects).
  if (/<!--(?:(?!-->)[\s\S])*$/.test(xml)) return true;
  // (b) a '<' literal inside an attribute value.
  for (const m of xml.matchAll(/=\s*(["'])([\s\S]*?)\1/g)) {
    if (m[2].includes("<")) return true;
  }
  // (c) the reserved 'xml' PI target (any case): <?xml ...?> after the root
  //     opens, or a bare <?xml?> that is not the leading declaration. A LEADING
  //     <?xml version=...?> (per XML 1.0, at document start, optionally preceded
  //     by a BOM U+FEFF) is a BENIGN XMLDecl -- not a #78 well-formedness gap --
  //     so its `<?` must be skipped. The exclusion was described in this comment
  //     but never coded (#84): without it, a mutator that ever synthesized a
  //     leading declaration on a NEW divergence would suppress it as KNOWN #78.
  const declStart = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (const m of xml.matchAll(/<\?\s*([A-Za-z_][\w.-]*)/g)) {
    if (m[1].toLowerCase() !== "xml") continue;
    if (m.index === declStart) continue; // leading XMLDecl is benign
    return true;
  }
  return false;
}

/**
 * Classify a divergence into a KNOWN family, or null (a genuinely NEW divergence
 * that FAILS the campaign). CAUSALLY GATED by the mismatch KIND so a fingerprint
 * can never suppress a divergence of the wrong phenomenology:
 *
 *   - a CRASH is never KNOWN.
 *   - a DECISION mismatch (one engine accepts, the other rejects) is the
 *     fast-xml-parser-leniency phenomenon: only #78 (well-formedness gap) now
 *     applies. (#75 -- bad entity/ref -- was FIXED in air-ts, so it no longer
 *     diverges; a bad-reference decision mismatch would now be NEW.)
 *   - a HASH mismatch (both accept, models differ) has NO remaining KNOWN
 *     family: #76 whitespace normalization was FIXED in air-ts, so a residual
 *     hash divergence is genuinely NEW and must fail the campaign.
 *   - a "codes" mismatch (both reject, different SEC codes) matches no family.
 *
 * Extra positional args from legacy call sites (the oracle outcome / a reparse
 * fn, once used by the removed #76 causal check) are ignored.
 */
function classifyKnown(xml, cmp) {
  if (!cmp || cmp.kind === "crash") return null;
  if (cmp.kind === "decision") {
    if (has78Fingerprint(xml)) return "#78";
    return null;
  }
  // HASH / codes mismatch or anything unexpected -> NEW (no KNOWN family remains).
  return null;
}

// --------------------------------------------------------------------------- //
// Outcome comparison.
// --------------------------------------------------------------------------- //

const sortedCodes = (codes) => (codes || []).slice().sort().join(",");

/** Compare two engine outcomes. Returns {match, kind} where kind describes a
 * mismatch: "crash" | "decision" | "codes" | "hash" | null. */
function compareOutcomes(ts, py) {
  if (ts.status === "crash" || py.status === "crash") {
    return { match: false, kind: "crash" };
  }
  if (ts.status !== py.status) return { match: false, kind: "decision" };
  if (ts.status === "accept") {
    if (ts.modelHash !== py.modelHash) return { match: false, kind: "hash" };
    return { match: true, kind: null };
  }
  // reject: compare the rejection CLASS (SEC- code set, order-insensitive).
  if (sortedCodes(ts.codes) !== sortedCodes(py.codes)) {
    return { match: false, kind: "codes" };
  }
  return { match: true, kind: null };
}

// --------------------------------------------------------------------------- //
// Oracle driver: one long-lived `air fuzz-eval --batch` subprocess.
// --------------------------------------------------------------------------- //

class OracleClient {
  constructor() {
    this.proc = spawn(PYTHON, ["-m", "air.cli", "fuzz-eval", "--batch"], {
      env: { ...process.env, PYTHONPATH: CORE_SRC, PYTHONUTF8: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this._buf = "";
    this._queue = [];
    this._closed = false;
    this.proc.stdout.setEncoding("utf-8");
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.on("close", () => {
      this._closed = true;
      // Reject any pending waiters if the process died.
      while (this._queue.length) this._queue.shift().reject(new Error("oracle process closed"));
    });
  }

  _onData(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf("\n")) !== -1) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      const waiter = this._queue.shift();
      if (waiter) waiter.resolve(JSON.parse(line));
    }
  }

  eval(xml) {
    if (this._closed) return Promise.reject(new Error("oracle process closed"));
    const bytes = Buffer.from(xml, "utf-8");
    this.proc.stdin.write(String(bytes.length) + "\n");
    this.proc.stdin.write(bytes);
    return new Promise((resolve, reject) => this._queue.push({ resolve, reject }));
  }

  close() {
    try {
      this.proc.stdin.end();
    } catch {
      /* already closed */
    }
  }
}

// --------------------------------------------------------------------------- //
// Shrinker: reduce a divergent input to a minimal reproducer that still
// diverges (and is still classified the same way). Deterministic delta-debug on
// the token stream, then on characters.
// --------------------------------------------------------------------------- //

async function stillDiverges(xml, parseOutcome, oracle) {
  const ts = safeTs(xml, parseOutcome);
  let py;
  try {
    py = await oracle.eval(xml);
  } catch {
    return null;
  }
  const cmp = compareOutcomes(ts, py);
  if (cmp.match) return null;
  return { ts, py, cmp };
}

function safeTs(xml, parseOutcome) {
  try {
    return parseOutcome(xml);
  } catch (err) {
    // parseOutcome is contracted never to throw; if it does, treat as crash.
    return { status: "crash", error: String(err && err.message ? err.message : err) };
  }
}

async function shrink(xml, parseOutcome, oracle) {
  let best = xml;
  let guard = 0;
  let progress = true;
  while (progress && guard++ < 200) {
    progress = false;
    // Token-level removal.
    const tokens = tokenize(best);
    for (let k = 0; k < tokens.length; k++) {
      const candidateTokens = tokens.slice(0, k).concat(tokens.slice(k + 1));
      const candidate = serialize(candidateTokens);
      if (candidate === best || candidate.length === 0) continue;
      const div = await stillDiverges(candidate, parseOutcome, oracle);
      if (div) {
        best = candidate;
        progress = true;
        break;
      }
    }
  }
  // Character-level trim from both ends.
  progress = true;
  guard = 0;
  while (progress && guard++ < 500) {
    progress = false;
    for (const cand of [best.slice(1), best.slice(0, -1)]) {
      if (!cand.length || cand === best) continue;
      const div = await stillDiverges(cand, parseOutcome, oracle);
      if (div) {
        best = cand;
        progress = true;
        break;
      }
    }
  }
  return best;
}

// --------------------------------------------------------------------------- //
// Corpus loading.
// --------------------------------------------------------------------------- //

function loadCorpus() {
  const designs = [];
  for (const entry of readdirSync(CORPUS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const input = join(CORPUS_DIR, entry.name, "input.air.xml");
    if (!existsSync(input)) continue;
    designs.push({ name: entry.name, xml: readFileSync(input, "utf-8") });
  }
  designs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return designs;
}

// --------------------------------------------------------------------------- //
// Regression emitter.
// --------------------------------------------------------------------------- //

function emitRegression(index, xml, meta) {
  if (!existsSync(REGRESSION_DIR)) mkdirSync(REGRESSION_DIR, { recursive: true });
  const stem = join(REGRESSION_DIR, `divergence_${String(index).padStart(3, "0")}`);
  writeFileSync(`${stem}.air.xml`, xml, "utf-8");
  writeFileSync(`${stem}.json`, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  return `${stem}.air.xml`;
}

// --------------------------------------------------------------------------- //
// Main campaign.
// --------------------------------------------------------------------------- //

async function runCampaign({ seed, cases, emitRegressions, maxNewToShrink }) {
  const { parseOutcome } = await import(pathToFileURL(AIRTS_DIST).href);
  const corpus = loadCorpus();
  if (!corpus.length) throw new Error(`no corpus designs under ${CORPUS_DIR}`);
  const rng = mulberry32(seed);
  const oracle = new OracleClient();

  const knownByFamily = { "#78": 0 };
  const newDivergences = [];
  let matched = 0;

  try {
    for (let c = 0; c < cases; c++) {
      const base = pick(rng, corpus);
      const { xml, applied } = mutate(base.xml, rng);
      const ts = safeTs(xml, parseOutcome);
      let py;
      try {
        py = await oracle.eval(xml);
      } catch (err) {
        newDivergences.push({ xml, applied, base: base.name, kind: "oracle-error", detail: String(err) });
        continue;
      }
      const cmp = compareOutcomes(ts, py);
      if (cmp.match) {
        matched++;
        continue;
      }
      // A crash is ALWAYS a failure -- never classifiable as KNOWN.
      if (cmp.kind === "crash") {
        newDivergences.push({ xml, applied, base: base.name, kind: "crash", ts, py });
        continue;
      }
      const family = classifyKnown(xml, cmp, py, parseOutcome);
      if (family) {
        knownByFamily[family]++;
      } else {
        newDivergences.push({ xml, applied, base: base.name, kind: cmp.kind, ts, py });
      }
    }

    // Shrink and (optionally) archive NEW divergences.
    const shrunk = [];
    const toShrink = newDivergences.slice(0, maxNewToShrink);
    for (let i = 0; i < toShrink.length; i++) {
      const d = toShrink[i];
      let minimal = d.xml;
      if (d.kind !== "oracle-error") {
        minimal = await shrink(d.xml, parseOutcome, oracle);
      }
      const minTs = safeTs(minimal, parseOutcome);
      const minPy = await oracle
        .eval(minimal)
        .catch((e) => ({ status: "crash", error: String(e) }));
      const minCmp = compareOutcomes(minTs, minPy);
      const meta = {
        seed,
        base: d.base,
        mutators: d.applied,
        mismatchKind: d.kind,
        classifiedKnown: classifyKnown(minimal, minCmp, minPy, parseOutcome),
        ts: minTs,
        py: minPy,
        minimalInput: minimal,
      };
      let file = null;
      if (emitRegressions) file = emitRegression(i, minimal, meta);
      shrunk.push({ ...meta, file });
    }

    return {
      seed,
      cases,
      matched,
      knownByFamily,
      newCount: newDivergences.length,
      shrunk,
    };
  } finally {
    oracle.close();
  }
}

// --------------------------------------------------------------------------- //
// Regression corpus: the minimal reproducers of every divergence family the
// fuzzer has surfaced, archived permanently so normal CI re-checks them forever
// (issue #43 deliverable 4). Each entry is a MINIMAL, hand-verified reproducer
// (the shrinker produces these; they are frozen here so they run without a live
// campaign). A regression test drives BOTH engines over each and asserts the
// currently-expected relationship: a `diverge-known` fixture stays a KNOWN
// divergence with its filed issue; a `reject-agree` (security) fixture is
// rejected identically; an `accept-agree` fixture is a divergence FIXED upstream
// that must now AGREE (e.g. agree_80_multiple_setup, fixed by PR #79 / issue
// #8). When a family's fix lands its fixture flips from `diverge-known` to
// `accept-agree`, the classifier entry is dropped, and the fixture then GUARDS
// the fix (a revert re-diverges and fails CI).
// --------------------------------------------------------------------------- //

const REGRESSION_CASES = [
  {
    name: "diff_75_named_entity",
    issue: "#75",
    note: "undefined named entity &nbsp;: expat rejects. FIXED (PR #75) -- air-ts's rejectBadReferences now REJECTS it too (both engines reject with codes=[]), so they AGREE. Kept as a guard: if the reject gate is reverted, fast-xml-parser resolves &nbsp;->space and this re-diverges, failing CI.",
    xml: '<system name="t" ir_version="0.1"><metadata><title>&nbsp;</title></metadata></system>',
    expect: "reject-agree",
  },
  {
    name: "diff_75_undefined_entity_foo",
    issue: "#75",
    note: "undefined named entity &foo;: expat rejects. FIXED (PR #75) -- air-ts's rejectBadReferences now REJECTS it too (both engines reject with codes=[]), so they AGREE. Guard against a reverted reject gate.",
    xml: '<system name="t" ir_version="0.1"><metadata><title>&foo;</title></metadata></system>',
    expect: "reject-agree",
  },
  {
    name: "diff_76_tab_in_attr",
    issue: "#76",
    note: "literal tab in attribute value: expat normalizes it to a space at parse time. FIXED (PR #76) -- air-ts's normalizeXmlWhitespace now applies the same parse-time normalization, so both engines ACCEPT with an identical model. Guard against a reverted normalizer.",
    xml: '<system name="a\tb" ir_version="0.1"></system>',
    expect: "accept-agree",
  },
  {
    name: "diff_78_comment_double_hyphen",
    issue: "#78",
    note: "comment content contains '--': expat rejects as not well-formed",
    xml: '<system name="t" ir_version="0.1"><!-- a--b --></system>',
  },
  {
    name: "diff_78_lt_in_attr",
    issue: "#78",
    note: "'<' literal in attribute value: expat rejects as not well-formed",
    xml: '<system name="a<b" ir_version="0.1"></system>',
  },
  {
    name: "diff_78_reserved_xml_pi",
    issue: "#78",
    note: "reserved 'xml' PI target mid-document: expat rejects",
    xml: '<system name="t" ir_version="0.1"><?xml v?></system>',
  },
  {
    name: "agree_80_multiple_setup",
    issue: "#80",
    note: "two <setup> blocks in one <test>: FIXED upstream (PR #79/issue #8) -- air-ts now merges all <setup> children like the oracle, so both engines AGREE. Kept as a regression GUARD: if the parser.ts findAll(test,'setup') fix is reverted, this fixture (and a fresh campaign) catch it.",
    xml:
      '<system name="t" ir_version="0.1"><tests><test id="x">' +
      '<setup><set_voltage net="a" value="1V"/></setup>' +
      '<setup><set_voltage net="b" value="2V"/></setup>' +
      "</test></tests></system>",
    expect: "accept-agree",
  },
  {
    name: "sec_001_doctype",
    issue: "SEC-001",
    note: "DOCTYPE rejected identically by both engines (security contract)",
    xml: '<!DOCTYPE x><system name="t" ir_version="0.1"></system>',
    expect: "reject-agree",
  },
  {
    name: "sec_001_billion_laughs",
    issue: "SEC-001",
    note: "billion-laughs entity payload rejected before expansion by both engines",
    xml:
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">' +
      '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>' +
      "<lolz>&lol2;</lolz>",
    expect: "reject-agree",
  },
  {
    name: "sec_008_invalid_charref",
    issue: "SEC-008",
    note: "numeric char ref to an XML-1.0-invalid code point rejected by both engines",
    xml: '<system name="t" ir_version="0.1"><metadata><title>a&#8;b</title></metadata></system>',
    expect: "reject-agree",
  },
];

async function makeRegressions() {
  const { parseOutcome } = await import(pathToFileURL(AIRTS_DIST).href);
  const oracle = new OracleClient();
  if (!existsSync(REGRESSION_DIR)) mkdirSync(REGRESSION_DIR, { recursive: true });
  try {
    for (const c of REGRESSION_CASES) {
      const ts = safeTs(c.xml, parseOutcome);
      const py = await oracle.eval(c.xml);
      const cmp = compareOutcomes(ts, py);
      const family = classifyKnown(c.xml, cmp, py, parseOutcome);
      const meta = {
        issue: c.issue,
        note: c.note,
        expect: c.expect || "diverge-known",
        classifiedKnown: family,
        diverges: !cmp.match,
        mismatchKind: cmp.kind,
        ts,
        py,
        input: c.xml,
      };
      writeFileSync(join(REGRESSION_DIR, `${c.name}.air.xml`), c.xml, "utf-8");
      writeFileSync(
        join(REGRESSION_DIR, `${c.name}.json`),
        JSON.stringify(meta, null, 2) + "\n",
        "utf-8",
      );
      let status;
      if (c.expect === "reject-agree") {
        status = cmp.match ? "AGREE-REJECT" : "!! expected reject-agree";
      } else if (c.expect === "accept-agree") {
        status = cmp.match ? "AGREE-ACCEPT" : "!! expected accept-agree";
      } else {
        status = family ? `KNOWN ${family}` : "!! NEW";
      }
      console.log(`  ${c.name.padEnd(28)} ${status}`);
    }
  } finally {
    oracle.close();
  }
  console.log(`wrote ${REGRESSION_CASES.length} regression fixtures to ${REGRESSION_DIR}`);
}

// --------------------------------------------------------------------------- //
// Self-test: prove the fuzzer's own machinery has teeth WITHOUT the engines.
// --------------------------------------------------------------------------- //

function selfTest() {
  let pass = 0;
  let fail = 0;
  const check = (name, cond) => {
    if (cond) {
      pass++;
      console.log(`  PASS  ${name}`);
    } else {
      fail++;
      console.log(`  FAIL  ${name}`);
    }
  };

  // Determinism: same seed -> identical mutation sequence.
  const base = '<system name="t" ir_version="0.1"><nets><net id="gnd"/></nets></system>';
  const seqA = [];
  const seqB = [];
  const rA = mulberry32(42);
  const rB = mulberry32(42);
  for (let i = 0; i < 50; i++) {
    seqA.push(mutate(base, rA).xml);
    seqB.push(mutate(base, rB).xml);
  }
  check("determinism: same seed -> identical case sequence", JSON.stringify(seqA) === JSON.stringify(seqB));
  const rC = mulberry32(43);
  const seqC = [];
  for (let i = 0; i < 50; i++) seqC.push(mutate(base, rC).xml);
  check("determinism: different seed -> different sequence", JSON.stringify(seqA) !== JSON.stringify(seqC));

  // Tokenize/serialize round-trips losslessly.
  check("tokenizer round-trips the base design", serialize(tokenize(base)) === base);

  // numeric-id-rename mutator: produces integer-like id values (the #79 class).
  const idDoc = '<system name="t"><nets><net id="alpha"/><net id="beta"/></nets></system>';
  let sawNumeric = false;
  const rIds = mulberry32(5);
  for (let i = 0; i < 40 && !sawNumeric; i++) {
    const out = mutNumericIdRename(tokenize(idDoc), rIds);
    if (/\bid="(?:\d+|0x1|007)"/.test(serialize(out))) sawNumeric = true;
  }
  check("numeric-id-rename produces integer-like ids", sawNumeric);
  check("numeric-id-rename is in the mutator inventory", MUTATORS.some(([n]) => n === "numeric-id-rename"));

  // ---- KNOWN classifier: CAUSALLY GATED by mismatch kind ----------------- //
  // Reusable comparison verdicts + oracle outcomes for the classifier tests.
  const DECISION = { match: false, kind: "decision" };
  const HASH = { match: false, kind: "hash" };
  const CRASH = { match: false, kind: "crash" };
  const CODES = { match: false, kind: "codes" };
  const pyReject = { status: "reject", codes: [] };

  // #75 (undefined/malformed references) and #76 (attribute-value + CR whitespace
  // normalization) were FIXED in air-ts's XML layer (rejectBadReferences /
  // normalizeXmlWhitespace in packages/air-ts/src/xml.ts), so they NO LONGER
  // diverge and their suppression families were REMOVED. A bad-reference DECISION
  // mismatch or a whitespace HASH mismatch must now classify NEW (null) -- exactly
  // so a reverted fix FAILS the campaign instead of being masked as KNOWN.
  const tabAttr = '<system name="a\tb" ir_version="0.1"></system>';
  check("#75 removed: undefined named entity is NOT auto-KNOWN (would be NEW)",
    classifyKnown('<system><t>&nbsp;</t></system>', DECISION, pyReject) === null);
  check("#75 removed: &foo; is NOT auto-KNOWN",
    classifyKnown('<system><t>&foo;</t></system>', DECISION, pyReject) === null);
  check("#75 removed: bare ampersand is NOT auto-KNOWN",
    classifyKnown('<system><t>a & b</t></system>', DECISION, pyReject) === null);
  check("#76 removed: tab-in-attr hash divergence is NOT auto-KNOWN (would be NEW)",
    classifyKnown(tabAttr, HASH) === null);
  check("#76 removed: CR-in-attr hash divergence is NOT auto-KNOWN",
    classifyKnown('<system name="a\rb"/>', HASH) === null);

  // #78 (DECISION mismatch): well-formedness gaps -- the ONLY remaining family.
  check("#78: comment containing --", classifyKnown('<system><!-- a--b --></system>', DECISION, pyReject) === "#78");
  check("#78: comment ending in hyphen", classifyKnown('<system><!-- a---></system>', DECISION, pyReject) === "#78");
  check("#78: unterminated comment", classifyKnown('<system><!-- a', DECISION, pyReject) === "#78");
  check("#78: '<' in attribute value", classifyKnown('<system name="a<b"/>', DECISION, pyReject) === "#78");
  check("#78: reserved xml PI target", classifyKnown('<system><?xml v?></system>', DECISION, pyReject) === "#78");
  check("#78 narrow: clean comment", classifyKnown('<system><!-- ok --></system>', DECISION, pyReject) === null);
  check("#78 narrow: non-xml PI target", classifyKnown('<system><?pi data?></system>', DECISION, pyReject) === null);
  check("#78 narrow: normal attribute", classifyKnown('<system name="ab"/>', DECISION, pyReject) === null);

  // ---- THE VERIFIER'S FLIP EXPERIMENT (round-1 finding) ------------------ //
  // A form-feed in an attribute value is a genuinely NEW divergence (expat
  // rejects the invalid char -> a DECISION mismatch). It must classify NEW, and
  // adding a CR anywhere must NOT flip it to KNOWN -- with #76 removed this is
  // even clearer (a CR fingerprint now reaches no family at all).
  const ffAttr = '<system name="a\fb" ir_version="0.1"></system>';
  check("FLIP: form-feed-in-attr divergence classifies NEW (decision)",
    classifyKnown(ffAttr, DECISION, pyReject) === null);
  check("FLIP: form-feed-in-attr + trailing CR STILL NEW (CR causally irrelevant)",
    classifyKnown(ffAttr + "\r", DECISION, pyReject) === null);
  check("FLIP: form-feed-in-attr + CR in element text STILL NEW",
    classifyKnown('<system name="a\fb"><t>x\ry</t></system>', DECISION, pyReject) === null);
  // #84 (verifier's leading-decl probe): a BENIGN leading <?xml version="1.0"?>
  // is not a #78 well-formedness gap, so it must NOT flip a form-feed-in-attr
  // NEW divergence to KNOWN #78. Before the clause-(c) exclusion, this probe
  // would suppress as #78; after, it correctly stays NEW.
  check("FLIP #84: leading <?xml?> + form-feed-in-attr STILL NEW (not #78)",
    classifyKnown('<?xml version="1.0"?><system name="a\fb" ir_version="0.1"></system>', DECISION, pyReject) === null);
  // #78 clause (c) NARROWNESS: a leading XMLDecl on its own is not #78, but a
  // NON-leading <?xml?> (mid-document, or after any prefix) still is.
  check("#78 narrow: leading <?xml version=?> alone is NOT #78",
    classifyKnown('<?xml version="1.0"?><system/>', DECISION, pyReject) === null);
  check("#78 narrow: leading <?xml?> after a BOM is NOT #78",
    classifyKnown('﻿<?xml version="1.0"?><system/>', DECISION, pyReject) === null);
  check("#78: non-leading <?xml?> (whitespace before) IS #78",
    classifyKnown(' <?xml v?><system/>', DECISION, pyReject) === "#78");

  // ---- MISMATCH-KIND GATE (the causal core of the fix) ------------------- //
  check("gate: a whitespace-in-attr fingerprint on a DECISION mismatch is not KNOWN",
    classifyKnown(tabAttr, DECISION, pyReject) === null);
  check("gate: a #78 fingerprint on a HASH mismatch is NOT #78",
    classifyKnown('<system name="a<b"/>', HASH) === null);
  check("gate: a CRASH is never KNOWN", classifyKnown(tabAttr, CRASH, pyReject) === null);
  check("gate: a CODES mismatch (both reject, diff SEC codes) is never KNOWN",
    classifyKnown(tabAttr, CODES, pyReject) === null);
  check("gate: no cmp -> null (never KNOWN)", classifyKnown(tabAttr, null) === null);

  // #80 is FIXED upstream: it must NOT be a KNOWN family. A two-<setup> input
  // that (hypothetically) still produced a hash divergence classifies NEW.
  const twoSetups =
    '<system name="t"><tests><test id="x">' +
    '<setup><set_voltage net="a" value="1V"/></setup>' +
    '<setup><set_voltage net="b" value="2V"/></setup>' +
    '</test></tests></system>';
  check("#80 removed: a two-<setup> hash divergence is NOT auto-KNOWN (would be NEW)",
    classifyKnown(twoSetups, HASH) === null);

  // A fully benign mutation-free doc is not a divergence family (any kind).
  check("classifier: benign base -> null (decision)", classifyKnown(base, DECISION, pyReject) === null);
  check("classifier: benign base -> null (hash)", classifyKnown(base, HASH) === null);

  // compareOutcomes: crash is always a mismatch; accept-hash mismatch flagged.
  check("compare: crash in either engine mismatches", compareOutcomes({ status: "crash" }, { status: "accept", modelHash: "x" }).kind === "crash");
  check("compare: accept hash mismatch flagged", compareOutcomes({ status: "accept", modelHash: "a" }, { status: "accept", modelHash: "b" }).kind === "hash");
  check("compare: same accept hash matches", compareOutcomes({ status: "accept", modelHash: "a" }, { status: "accept", modelHash: "a" }).match === true);
  check("compare: reject code-set mismatch flagged", compareOutcomes({ status: "reject", codes: ["SEC-001"] }, { status: "reject", codes: ["SEC-002"] }).kind === "codes");
  check("compare: reject same code set matches", compareOutcomes({ status: "reject", codes: ["SEC-002", "SEC-001"] }, { status: "reject", codes: ["SEC-001", "SEC-002"] }).match === true);
  check("compare: decision mismatch flagged", compareOutcomes({ status: "accept", modelHash: "a" }, { status: "reject", codes: [] }).kind === "decision");

  console.log(`\nself-test: ${fail === 0 ? "PASSED" : fail + " FAILED"} (${pass} passed)`);
  return fail === 0 ? 0 : 1;
}

// --------------------------------------------------------------------------- //
// CLI.
// --------------------------------------------------------------------------- //

function parseArgs(argv) {
  const args = {
    seed: 1,
    cases: 1000,
    selfTest: false,
    makeRegressions: false,
    emitRegressions: false,
    maxNewToShrink: 10,
    jsonOut: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--self-test") args.selfTest = true;
    else if (a === "--make-regressions") args.makeRegressions = true;
    else if (a === "--seed") args.seed = parseInt(argv[++i], 10);
    else if (a === "--cases") args.cases = parseInt(argv[++i], 10);
    else if (a === "--emit-regressions") args.emitRegressions = true;
    else if (a === "--max-shrink") args.maxNewToShrink = parseInt(argv[++i], 10);
    else if (a === "--json-out") args.jsonOut = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    process.exit(selfTest());
  }
  if (args.makeRegressions) {
    await makeRegressions();
    process.exit(0);
  }
  const t0 = process.hrtime.bigint();
  const result = await runCampaign(args);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  console.log("=".repeat(72));
  console.log(`Differential fuzz campaign  seed=${result.seed}  cases=${result.cases}`);
  console.log("=".repeat(72));
  console.log(`matched (identical outcome): ${result.matched}`);
  console.log(`KNOWN divergences: #78=${result.knownByFamily["#78"]}`);
  console.log(`NEW divergences: ${result.newCount}`);
  console.log(`elapsed: ${elapsedMs.toFixed(0)} ms`);
  if (result.shrunk.length) {
    console.log("-".repeat(72));
    console.log("Shrunk NEW divergences:");
    for (const s of result.shrunk) {
      console.log(`  [${s.mismatchKind}] base=${s.base} known=${s.classifiedKnown} ${s.file || "(not archived)"}`);
      console.log(`    minimal: ${JSON.stringify(s.minimalInput)}`);
    }
  }
  if (args.jsonOut) {
    writeFileSync(args.jsonOut, JSON.stringify(result, null, 2) + "\n", "utf-8");
  }

  // Fail the run on any NEW divergence (KNOWN families are not failures).
  process.exit(result.newCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
