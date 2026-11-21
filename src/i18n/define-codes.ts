// A module's error codes: the inventory in code that `ErrorCode` (codes.ts)
// gathers. Clavix keeps its UPPER_SNAKE values (they are the contract with the
// UI and the SDK), so a code is its own value and `module` only names who
// declares it; the codes spec lists every code once.
export interface CodeGroup<Codes extends readonly string[]> {
  readonly module: string;
  readonly codes: Codes;
}

export function defineCodes<const Codes extends readonly string[]>(
  module: string,
  codes: Codes,
): CodeGroup<Codes> {
  return { module, codes };
}
