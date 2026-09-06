// Test-only source extractor for Chase's pure functions.
//
// index.html is a single monolithic file with no module boundaries — its
// functions cannot be `import`ed. This module reads index.html AS TEXT
// (it is never written to, and never modified), locates the exact,
// current source of a small set of approved pure functions/constants by
// their real signatures, and evaluates ONLY those extracted declarations
// inside isolated Node `vm` sandboxes.
//
// It also reads src/chase-engine/stats.js and src/chase-engine/
// stroke-cycles.js in full (no anchor search needed — each whole small
// file IS its declarations) and includes them in the same sandbox:
// chaseDetectFreestyleCycles (now itself in stroke-cycles.js) calls
// summariseMetric (in stats.js). Neither file is ever written to.
//
// It deliberately never executes the rest of index.html — most of that
// file references `document`, `window`, MediaPipe, and Firebase globals
// that do not exist under Node and would throw immediately if run here.
//
// If index.html changes in a way that moves, renames, or reshapes one of
// these declarations, extraction fails loudly (a thrown Error identifying
// exactly which signature could not be found) rather than silently
// testing stale or wrong code.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = join(__dirname, "..", "index.html");
const STATS_MODULE_PATH = join(__dirname, "..", "src", "chase-engine", "stats.js");
const STROKE_CYCLES_MODULE_PATH = join(__dirname, "..", "src", "chase-engine", "stroke-cycles.js");

// ---------------------------------------------------------------------
// Balanced-block extraction
// ---------------------------------------------------------------------
//
// Given the index of an opening `{` or `[`, returns the full matching
// block (inclusive of both brackets), skipping over string, template
// literal, and comment contents so a bracket character appearing inside
// one of those is never mistaken for code structure.
//
// This uses a single unified stack of currently-open brackets/template
// literals, rather than one depth counter for "the" bracket type being
// matched. That matters because the extracted source mixes bracket
// types: CHASE_COACHING_RULES is a `[ ... ]` array containing `{ ... }`
// rule objects, whose fields include template literals with their own
// `${ ... }` expression braces. A single depth counter scoped to just
// `[`/`]` (or just `{`/`}`) cannot also track the other bracket type
// nested inside it. Pushing `` ` `` for a template literal (not just a
// boolean flag) is what makes `${ ... }` resolve correctly: its brace is
// pushed as an ordinary `{`, and when that `{` is popped, whatever is
// now on top of the stack — still `` ` `` — correctly signals "back in
// raw template text", with no separate counter that can desync from
// what's actually open.
function extractBalancedBlock(text, openIndex) {
  const targetOpen = text[openIndex];

  if (targetOpen !== "{" && targetOpen !== "[") {
    throw new Error(
      `extractBalancedBlock: unsupported opening character ${JSON.stringify(targetOpen)} at index ${openIndex}`
    );
  }

  const stack = [targetOpen];
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIndex + 1; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inSingle) {
      if (ch === "\\") { i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }

    if (inDouble) {
      if (ch === "\\") { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }

    if (stack[stack.length - 1] === "`") {
      // Raw template-literal text.
      if (ch === "\\") { i++; continue; }
      if (ch === "`") { stack.pop(); continue; }
      if (ch === "$" && next === "{") {
        stack.push("{");
        i++;
        continue;
      }
      continue;
    }

    // Normal code scanning.
    if (ch === "/" && next === "/") { inLineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlockComment = true; i++; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "`") { stack.push("`"); continue; }
    if (ch === "{") { stack.push("{"); continue; }
    if (ch === "[") { stack.push("["); continue; }

    if (ch === "}") {
      if (stack[stack.length - 1] !== "{") {
        throw new Error(`extractBalancedBlock: unmatched "}" at index ${i}`);
      }
      stack.pop();
      if (stack.length === 0) return text.slice(openIndex, i + 1);
      continue;
    }

    if (ch === "]") {
      if (stack[stack.length - 1] !== "[") {
        throw new Error(`extractBalancedBlock: unmatched "]" at index ${i}`);
      }
      stack.pop();
      if (stack.length === 0) return text.slice(openIndex, i + 1);
      continue;
    }
  }

  throw new Error(
    `extractBalancedBlock: reached end of file without closing the "${targetOpen}" opened at index ${openIndex}`
  );
}

// ---------------------------------------------------------------------
// Approved extraction targets
// ---------------------------------------------------------------------
//
// Each anchor is the exact, literal current source text of a function or
// const signature, ending in the block's opening bracket. Anchors are
// matched by exact substring, not regex, and extraction fails loudly if
// an anchor is missing or ambiguous (found more than once).

const TARGETS = {
  CHASE_COACHING_RULES: "const CHASE_COACHING_RULES = [",
  timeToSeconds: "function timeToSeconds(t) {",
  formatTime: "function formatTime(seconds) {",
  capitalize: "function capitalize(s) {",
};

function extractDeclaration(source, name) {
  const anchor = TARGETS[name];

  if (!anchor) {
    throw new Error(`extractDeclaration: "${name}" is not an approved extraction target.`);
  }

  const anchorIndex = source.indexOf(anchor);

  if (anchorIndex === -1) {
    throw new Error(
      `Chase source extraction failed for "${name}": could not find the expected ` +
      `signature ${JSON.stringify(anchor)} in index.html. Either the function was ` +
      `renamed/removed/reshaped (a behavior change requiring approval per CLAUDE.md), ` +
      `or this extractor's anchor is stale and needs updating to match the current source.`
    );
  }

  const secondIndex = source.indexOf(anchor, anchorIndex + 1);

  if (secondIndex !== -1) {
    throw new Error(
      `Chase source extraction failed for "${name}": the signature ${JSON.stringify(anchor)} ` +
      `appears more than once in index.html, so extraction is ambiguous.`
    );
  }

  const openIndex = anchorIndex + anchor.length - 1;
  const block = extractBalancedBlock(source, openIndex);

  return source.slice(anchorIndex, openIndex) + block;
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

let cachedSource = null;

function readIndexHtml() {
  if (cachedSource === null) {
    cachedSource = readFileSync(INDEX_HTML_PATH, "utf8");
  }
  return cachedSource;
}

const PURE_FUNCTION_NAMES = [
  "timeToSeconds",
  "formatTime",
  "capitalize",
];

// Defined in src/chase-engine/stats.js rather than index.html — see the
// STATS_MODULE_PATH read in loadChaseFunctions() below.
const STATS_FUNCTION_NAMES = ["averageValid", "summariseMetric"];

/**
 * Extracts the approved Chase pure functions and CHASE_COACHING_RULES
 * from the current index.html source and evaluates them in a fresh,
 * isolated vm sandbox. Returns the sandbox object, which exposes each
 * extracted function/constant as a property (e.g. `chase.summariseMetric`,
 * `chase.CHASE_COACHING_RULES`), plus a mutable `metricsHistory` object
 * that `chaseDetectFreestyleCycles` reads as a global — this is
 * synthetic test fixture data supplied by the harness, not something
 * extracted from index.html, and tests may reassign its fields freely
 * between cases.
 *
 * index.html is only ever read here, never written to or executed in
 * full — only the specific extracted declarations run, inside their own
 * sandbox realm.
 */
export function loadChaseFunctions() {
  const source = readIndexHtml();

  const declarations = PURE_FUNCTION_NAMES.map((name) => extractDeclaration(source, name));

  // averageValid and summariseMetric now live in src/chase-engine/stats.js.
  // The whole (small) file is read directly and included here — no anchor
  // search needed, since the whole file IS the declarations — ahead of
  // stroke-cycles.js below, which calls summariseMetric.
  declarations.push(readFileSync(STATS_MODULE_PATH, "utf8"));

  // chaseDetectFreestyleCycles now lives in src/chase-engine/stroke-cycles.js.
  // Same whole-file read as stats.js above. It calls summariseMetric
  // (provided just above) and reads a module-level `metricsHistory`
  // object that this harness supplies via the sandbox global (see
  // below) rather than extracting from index.html, since it is test
  // input, not Chase source.
  declarations.push(readFileSync(STROKE_CYCLES_MODULE_PATH, "utf8"));

  // CHASE_COACHING_RULES is declared with `const`. Top-level `const`
  // bindings evaluated via vm.runInContext do NOT become properties of
  // the sandbox's global object (only `function`/`var` declarations do),
  // so a bridging assignment is appended in the SAME script execution,
  // after the untouched extracted declaration, purely to expose it to
  // the harness. This does not alter the extracted array or its
  // behavior in any way.
  const coachingRulesDeclaration = extractDeclaration(source, "CHASE_COACHING_RULES");

  const code = [
    ...declarations,
    `${coachingRulesDeclaration};`,
    "globalThis.CHASE_COACHING_RULES = CHASE_COACHING_RULES;",
  ].join("\n\n");

  const sandbox = {
    metricsHistory: {
      elbow: [],
      alignment: [],
      rotation: [],
      armSymmetry: [],
      hipAlignment: [],
      kneeAngle: [],
      lateralX: [],
      wristMinY: [],
      timestamps: [],
    },
  };

  vm.createContext(sandbox);

  try {
    vm.runInContext(code, sandbox, { filename: "extracted-chase-functions.vm.js" });
  } catch (error) {
    throw new Error(
      `Failed to evaluate extracted Chase source in an isolated vm sandbox: ${error.message}`
    );
  }

  const expectedGlobals = [
    ...PURE_FUNCTION_NAMES,
    ...STATS_FUNCTION_NAMES,
    "chaseDetectFreestyleCycles",
    "CHASE_COACHING_RULES",
  ];

  for (const name of expectedGlobals) {
    if (typeof sandbox[name] === "undefined") {
      throw new Error(
        `Chase source extraction ran without error, but "${name}" is not present on the ` +
        `sandbox afterwards. This should not happen for a correctly extracted declaration ` +
        `and likely indicates a bug in the extractor itself.`
      );
    }
  }

  return sandbox;
}
