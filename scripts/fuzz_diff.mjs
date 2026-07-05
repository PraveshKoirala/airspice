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
 * KNOWN-divergence classifier: findings whose fingerprint matches a DISCLOSED
 * divergence family (#75 named-entity / malformed-ref handling; #76 attribute
 * whitespace normalization) are reported as KNOWN (counted per family), NOT as
 * failures. The classifier is NARROW -- it matches family fingerprints on the
 * mutated input, never a blanket "any mismatch is fine" -- and is self-tested
 * (`--self-test`). A NEW divergence (no family match) fails the run and is
 * auto-shrunk to a minimal reproducer.
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
// KNOWN-divergence classifier. NARROW by construction: it fingerprints the
// mutated INPUT for the two DISCLOSED families and only accepts a divergence as
// KNOWN when the fingerprint is present. It never suppresses on the basis of
// "the outcomes differ" alone.
//
//   #75  entity / char-ref handling: undefined named entities (&nbsp;, &foo;)
//        and malformed reference syntax (&#X42;, &#;, a bare &). expat rejects;
//        fast-xml-parser resolves/keeps-literal. Fingerprint: the input contains
//        an ampersand-reference that is NOT one of the 5 predefined XML entities
//        and NOT a well-formed numeric ref (&#dd; / &#xHH;).
//   #76  attribute-value / CR whitespace normalization: a literal TAB/newline in
//        an ATTRIBUTE value, or a CR in text, that expat normalizes at parse
//        time and fast-xml-parser does not. Fingerprint: an attribute value that
//        contains a raw \t / \n / \r, or a \r in text.
//   #78  well-formedness gaps: fast-xml-parser accepts constructs expat rejects
//        as "not well-formed" -- a comment whose content contains "--" (or ends
//        "--->"), a '<' literal inside an attribute value, and the reserved
//        'xml' PI target. FOUND BY THIS FUZZER (seed 1) and FILED as #78, with
//        shrunk regression fixtures under tests/fuzz_regressions/. Fingerprint:
//        those exact three structural conditions -- narrow, not "any reject".
//   #80  multiple <setup> blocks in one <test>: the oracle merges the children
//        of EVERY <setup> (findall("./setup/*")); air-ts reads only the first
//        (find("setup")), yielding an accept/accept MODEL divergence. FOUND BY
//        THIS FUZZER (seed 1000) and FILED as #80. Fingerprint: a single <test>
//        element containing two-or-more <setup> children -- narrow.
// --------------------------------------------------------------------------- //

// Predefined XML entities + well-formed numeric refs are NOT #75 divergences.
const PREDEFINED_ENTITY_RE = /&(?:amp|lt|gt|quot|apos);/g;
const NUMERIC_REF_RE = /&#(?:[0-9]+|x[0-9a-fA-F]+);/g;

function has75Fingerprint(xml) {
  // Strip the benign refs, then look for any remaining ampersand reference/token.
  const stripped = xml.replace(PREDEFINED_ENTITY_RE, "").replace(NUMERIC_REF_RE, "");
  // A remaining "&name;" (named entity) or malformed "&#X..;" / "&#;" / bare "&".
  return (
    /&[A-Za-z][A-Za-z0-9]*;/.test(stripped) || // undefined named entity
    /&#X[0-9a-fA-F]+;/.test(stripped) || // uppercase-X hex form (expat rejects)
    /&#;/.test(stripped) || // empty numeric ref
    /&(?![A-Za-z#])/.test(stripped) // bare ampersand not starting a ref
  );
}

function has76Fingerprint(xml) {
  // A raw tab/newline/CR inside an attribute value.
  for (const m of xml.matchAll(/=\s*(["'])([\s\S]*?)\1/g)) {
    if (/[\t\n\r]/.test(m[2])) return true;
  }
  // A CR in the document at all (expat drops CR in text).
  if (xml.includes("\r")) return true;
  return false;
}

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
  //     opens, or a bare <?xml?> that is not the leading declaration.
  for (const m of xml.matchAll(/<\?\s*([A-Za-z_][\w.-]*)/g)) {
    if (m[1].toLowerCase() === "xml") return true;
  }
  return false;
}

function has80Fingerprint(xml) {
  // #80: a <test> containing MORE THAN ONE <setup> block. The oracle merges the
  // children of every <setup> (findall("./setup/*")); air-ts reads only the
  // first (find("setup")). NARROW: fires only when a single <test> element
  // actually contains two-or-more <setup> children -- not on any test that has a
  // setup at all. We scan each <test>...</test> span for >=2 <setup ...> opens.
  for (const t of xml.matchAll(/<test\b[\s\S]*?<\/test>/g)) {
    const setupOpens = (t[0].match(/<setup\b/g) || []).length;
    if (setupOpens >= 2) return true;
  }
  return false;
}

/**
 * Classify a divergence. Returns a family id ("#75" | "#76" | "#78") when the
 * mutated input carries that family's fingerprint, else null (a genuinely NEW,
 * unfiled divergence). All three families are DISCLOSED/FILED with tracking
 * issues and regression fixtures; the classifier never suppresses on the basis
 * of "the outcomes differ" alone -- each branch requires the family's specific
 * structural fingerprint.
 */
function classifyKnown(xml) {
  if (has75Fingerprint(xml)) return "#75";
  if (has76Fingerprint(xml)) return "#76";
  if (has78Fingerprint(xml)) return "#78";
  if (has80Fingerprint(xml)) return "#80";
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

  const knownByFamily = { "#75": 0, "#76": 0, "#78": 0, "#80": 0 };
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
      const family = classifyKnown(xml);
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
      const meta = {
        seed,
        base: d.base,
        mutators: d.applied,
        mismatchKind: d.kind,
        classifiedKnown: classifyKnown(minimal),
        ts: safeTs(minimal, parseOutcome),
        py: await oracle.eval(minimal).catch((e) => ({ status: "crash", error: String(e) })),
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
// currently-expected relationship (KNOWN divergence with its filed issue, or --
// for the security fixtures -- identical rejection). When a family's fix lands,
// its fixtures flip from "diverges (KNOWN #NN)" to "agrees" and the classifier
// entry is dropped.
// --------------------------------------------------------------------------- //

const REGRESSION_CASES = [
  {
    name: "diff_75_named_entity",
    issue: "#75",
    note: "undefined named entity: expat rejects, fast-xml-parser resolves/keeps-literal",
    xml: '<system name="t" ir_version="0.1"><metadata><title>&nbsp;</title></metadata></system>',
  },
  {
    name: "diff_75_uppercase_hex_ref",
    issue: "#75",
    note: "malformed reference syntax &#X42; (uppercase X): expat rejects",
    xml: '<system name="t" ir_version="0.1"><metadata><title>&#X42;</title></metadata></system>',
  },
  {
    name: "diff_76_tab_in_attr",
    issue: "#76",
    note: "literal tab in attribute value: expat normalizes to space at parse time",
    xml: '<system name="a\tb" ir_version="0.1"></system>',
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
    name: "diff_80_multiple_setup",
    issue: "#80",
    note: "two <setup> blocks in one <test>: oracle merges both, air-ts reads first only",
    xml:
      '<system name="t" ir_version="0.1"><tests><test id="x">' +
      '<setup><set_voltage net="a" value="1V"/></setup>' +
      '<setup><set_voltage net="b" value="2V"/></setup>' +
      "</test></tests></system>",
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
      const family = classifyKnown(c.xml);
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
      const status = c.expect === "reject-agree" ? (cmp.match ? "AGREE-REJECT" : "!! expected agree") : (family ? `KNOWN ${family}` : "!! NEW");
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

  // KNOWN classifier: #75 fingerprints.
  check("#75: undefined named entity is classified", classifyKnown('<system><t>&nbsp;</t></system>') === "#75");
  check("#75: &foo; is classified", classifyKnown('<system><t>&foo;</t></system>') === "#75");
  check("#75: uppercase-X hex ref is classified", classifyKnown('<system><t>&#X42;</t></system>') === "#75");
  check("#75: empty numeric ref &#; is classified", classifyKnown('<system><t>&#;</t></system>') === "#75");
  check("#75: bare ampersand is classified", classifyKnown('<system><t>a & b</t></system>') === "#75");
  // NARROWNESS: predefined entities and well-formed numeric refs are NOT #75.
  check("#75 narrow: &amp; is NOT classified", classifyKnown('<system><t>&amp;</t></system>') === null);
  check("#75 narrow: &#65; is NOT classified", classifyKnown('<system><t>&#65;</t></system>') === null);
  check("#75 narrow: &#x42; is NOT classified", classifyKnown('<system><t>&#x42;</t></system>') === null);

  // KNOWN classifier: #76 fingerprints.
  check("#76: tab in attribute value is classified", classifyKnown('<system name="a\tb"/>') === "#76");
  check("#76: newline in attribute value is classified", classifyKnown('<system name="a\nb"/>') === "#76");
  check("#76: CR anywhere is classified", classifyKnown('<system>\r</system>') === "#76");
  // NARROWNESS: plain-space attribute and clean doc are NOT #76.
  check("#76 narrow: space in attribute is NOT classified", classifyKnown('<system name="a b"/>') === null);
  check("#76 narrow: clean document is NOT classified", classifyKnown(base) === null);

  // KNOWN classifier: #78 well-formedness fingerprints (found + filed by this
  // fuzzer). Ordering note: none of these carry a #75/#76 fingerprint, so they
  // resolve to #78.
  check("#78: comment containing -- is classified", classifyKnown('<system><!-- a--b --></system>') === "#78");
  check("#78: comment ending in hyphen is classified", classifyKnown('<system><!-- a---></system>') === "#78");
  check("#78: unterminated comment is classified", classifyKnown('<system><!-- a') === "#78");
  check("#78: '<' in attribute value is classified", classifyKnown('<system name="a<b"/>') === "#78");
  check("#78: reserved xml PI target is classified", classifyKnown('<system><?xml v?></system>') === "#78");
  // NARROWNESS: a well-formed comment / PI / attribute is NOT #78.
  check("#78 narrow: clean comment is NOT classified", classifyKnown('<system><!-- ok --></system>') === null);
  check("#78 narrow: non-xml PI target is NOT classified", classifyKnown('<system><?pi data?></system>') === null);
  check("#78 narrow: normal attribute is NOT classified", classifyKnown('<system name="ab"/>') === null);

  // KNOWN classifier: #80 multiple-<setup> (found + filed by this fuzzer).
  const twoSetups =
    '<system name="t"><tests><test id="x">' +
    '<setup><set_voltage net="a" value="1V"/></setup>' +
    '<setup><set_voltage net="b" value="2V"/></setup>' +
    '</test></tests></system>';
  check("#80: two <setup> blocks in one <test> is classified", classifyKnown(twoSetups) === "#80");
  // NARROWNESS: a single <setup> is NOT #80.
  const oneSetup =
    '<system name="t"><tests><test id="x">' +
    '<setup><set_voltage net="a" value="1V"/></setup></test></tests></system>';
  check("#80 narrow: single <setup> is NOT classified", classifyKnown(oneSetup) === null);
  // NARROWNESS: two <setup> in SEPARATE tests is NOT #80 (per-test count).
  const setupsAcrossTests =
    '<system name="t"><tests>' +
    '<test id="x"><setup/></test><test id="y"><setup/></test>' +
    '</tests></system>';
  check("#80 narrow: one <setup> each in two tests is NOT classified", classifyKnown(setupsAcrossTests) === null);

  // A fully benign mutation-free doc is not a divergence family.
  check("classifier: benign base -> null (no family)", classifyKnown(base) === null);

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
  console.log(
    `KNOWN divergences: #75=${result.knownByFamily["#75"]}  ` +
      `#76=${result.knownByFamily["#76"]}  #78=${result.knownByFamily["#78"]}  ` +
      `#80=${result.knownByFamily["#80"]}`,
  );
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
