// Small helper that bridges Node's `vm` module realm boundary for
// equality assertions.
//
// Functions extracted from index.html by extract-chase-functions.js run
// inside an isolated vm.createContext() sandbox, which has its own,
// separate Object/Array constructors. A plain object or array literal
// built inside that sandbox is therefore not the same "kind" of object
// as one built in a test file's own realm, even when every field
// matches exactly. assert.deepStrictEqual treats this as inequality —
// its error message is literally "Values have same structure but are
// not reference-equal" — because strict structural equality also
// compares prototypes/constructors, not just enumerable own-property
// values.
//
// normalizeVmValue() re-creates a value using only the CURRENT realm's
// plain Object/Array/primitive constructors, via a JSON round-trip.
// This is safe here specifically because every value returned by the
// extracted Chase functions under test is plain, JSON-serializable data
// — finite numbers, strings, null, and plain objects/arrays of those —
// never functions, class instances, Dates, or anything else a JSON
// round-trip would alter or drop.
//
// After normalization, assert.deepStrictEqual compares the actual
// values and structure with no realm artifact in the way. This does not
// weaken the assertion: the same fields, at the same strictness, are
// still being compared — only the irrelevant cross-realm prototype
// mismatch is removed.
export function normalizeVmValue(value) {
  return JSON.parse(JSON.stringify(value));
}
