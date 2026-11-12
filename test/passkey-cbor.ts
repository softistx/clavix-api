/** The few CBOR items a WebAuthn fixture needs: integers, byte and text strings, maps. */

export type Cbor = number | string | Uint8Array | ReadonlyMap<Cbor, Cbor>;

function head(major: number, value: number): number[] {
  const base = major << 5;
  if (value < 24) return [base | value];
  if (value < 256) return [base | 24, value];
  return [base | 25, value >> 8, value & 255];
}

export function encode(item: Cbor): Uint8Array {
  if (typeof item === "number") {
    return Uint8Array.from(item >= 0 ? head(0, item) : head(1, -1 - item));
  }
  if (typeof item === "string") {
    const bytes = new TextEncoder().encode(item);
    return Uint8Array.from([...head(3, bytes.length), ...bytes]);
  }
  if (item instanceof Uint8Array) {
    return Uint8Array.from([...head(2, item.length), ...item]);
  }
  const parts: number[] = head(5, item.size);
  for (const [key, value] of item) {
    parts.push(...encode(key), ...encode(value));
  }
  return Uint8Array.from(parts);
}
