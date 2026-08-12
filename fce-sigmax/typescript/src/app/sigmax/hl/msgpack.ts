/**
 * Deterministic MessagePack encoder — the subset Hyperliquid L1 actions actually use.
 *
 * WHY THIS EXISTS AT ALL: Hyperliquid hashes the msgpack encoding of an action and signs that hash,
 * so a single byte of disagreement with the reference encoder produces a valid-looking signature the
 * exchange rejects. The obvious fix is to depend on `@nktkas/hyperliquid` — but this code runs inside
 * the TEE, where every dependency byte is attested surface. 7.7 MB across three transitive packages
 * to obtain "msgpack + EIP-712 + one POST" is a bad trade, so we implement exactly what we need and
 * prove byte-equality against the real SDK in a differential test (`packages/agent`, which already
 * has the SDK as a dependency). Confidence without the surface.
 *
 * This is a faithful port of `@std/msgpack@1.0.3`'s encoder — the one the SDK uses — restricted to
 * the types that appear in an action. Anything outside that set throws rather than guessing, because
 * a silent encoding difference is exactly the failure mode this module exists to prevent.
 *
 * DETERMINISM: map keys are emitted in object insertion order, never sorted. That matches the
 * reference encoder, and it is why the order of fields in an action literal is load-bearing.
 */

const FOUR_BITS = 16;
const FIVE_BITS = 32;
const SEVEN_BITS = 128;
const EIGHT_BITS = 256;
const FIFTEEN_BITS = 32768;
const SIXTEEN_BITS = 65536;
const THIRTY_ONE_BITS = 2147483648;
const THIRTY_TWO_BITS = 4294967296;
const SIXTY_THREE_BITS = 9223372036854775808n;
const SIXTY_FOUR_BITS = 18446744073709551616n;

const textEncoder = new TextEncoder();

/** The value types this encoder accepts. Anything else is a bug, not a fallback. */
export type MsgpackValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | MsgpackValue[]
  | { [key: string]: MsgpackValue };

/** Encode a value to MessagePack bytes. */
export function encodeMsgpack(value: MsgpackValue): Uint8Array {
  const parts: Uint8Array[] = [];
  encodeInto(value, parts);
  return concatBytes(parts);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function encodeFloat64(num: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(9));
  view.setUint8(0, 0xcb);
  view.setFloat64(1, num);
  return new Uint8Array(view.buffer);
}

/**
 * Integers use the smallest fixed-width form; non-integers and integers past 2^32 fall back to
 * float64. That float64 fallback is why `prepareAction` promotes large integers to bigint first —
 * a nonce encoded as a float would hash differently from the reference.
 */
function encodeNumber(num: number): Uint8Array {
  if (!Number.isInteger(num)) return encodeFloat64(num);

  if (num < 0) {
    if (num >= -FIVE_BITS) return new Uint8Array([num]); // negative fixint (two's complement byte)
    if (num >= -SEVEN_BITS) return new Uint8Array([0xd0, num]); // int 8
    if (num >= -FIFTEEN_BITS) {
      const view = new DataView(new ArrayBuffer(3));
      view.setUint8(0, 0xd1);
      view.setInt16(1, num);
      return new Uint8Array(view.buffer);
    }
    if (num >= -THIRTY_ONE_BITS) {
      const view = new DataView(new ArrayBuffer(5));
      view.setUint8(0, 0xd2);
      view.setInt32(1, num);
      return new Uint8Array(view.buffer);
    }
    return encodeFloat64(num);
  }

  if (num <= 0x7f) return new Uint8Array([num]); // positive fixint
  if (num < EIGHT_BITS) return new Uint8Array([0xcc, num]); // uint 8
  if (num < SIXTEEN_BITS) {
    const view = new DataView(new ArrayBuffer(3));
    view.setUint8(0, 0xcd);
    view.setUint16(1, num);
    return new Uint8Array(view.buffer);
  }
  if (num < THIRTY_TWO_BITS) {
    const view = new DataView(new ArrayBuffer(5));
    view.setUint8(0, 0xce);
    view.setUint32(1, num);
    return new Uint8Array(view.buffer);
  }
  return encodeFloat64(num);
}

function encodeBigInt(value: bigint): Uint8Array {
  if (value < 0n) {
    if (value < -SIXTY_THREE_BITS) throw new Error("msgpack: bigint below int64 range");
    const view = new DataView(new ArrayBuffer(9));
    view.setUint8(0, 0xd3);
    view.setBigInt64(1, value);
    return new Uint8Array(view.buffer);
  }
  if (value >= SIXTY_FOUR_BITS) throw new Error("msgpack: bigint above uint64 range");
  const view = new DataView(new ArrayBuffer(9));
  view.setUint8(0, 0xcf);
  view.setBigUint64(1, value);
  return new Uint8Array(view.buffer);
}

/** Emit a length-prefixed header, picking the narrowest width the length fits in. */
function pushLengthPrefixed(
  parts: Uint8Array[],
  len: number,
  fixMask: number,
  fixLimit: number,
  short: number | null,
  medium: number,
  wide: number,
  what: string,
): void {
  if (len < fixLimit) {
    parts.push(new Uint8Array([fixMask | len]));
    return;
  }
  if (short !== null && len < EIGHT_BITS) {
    parts.push(new Uint8Array([short, len]));
    return;
  }
  if (len < SIXTEEN_BITS) {
    const view = new DataView(new ArrayBuffer(3));
    view.setUint8(0, medium);
    view.setUint16(1, len);
    parts.push(new Uint8Array(view.buffer));
    return;
  }
  if (len < THIRTY_TWO_BITS) {
    const view = new DataView(new ArrayBuffer(5));
    view.setUint8(0, wide);
    view.setUint32(1, len);
    parts.push(new Uint8Array(view.buffer));
    return;
  }
  throw new Error(`msgpack: ${what} longer than 32 bits`);
}

function encodeInto(value: MsgpackValue, parts: Uint8Array[]): void {
  if (value === null) {
    parts.push(new Uint8Array([0xc0]));
    return;
  }
  if (value === false) {
    parts.push(new Uint8Array([0xc2]));
    return;
  }
  if (value === true) {
    parts.push(new Uint8Array([0xc3]));
    return;
  }
  if (typeof value === "number") {
    parts.push(encodeNumber(value));
    return;
  }
  if (typeof value === "bigint") {
    parts.push(encodeBigInt(value));
    return;
  }
  if (typeof value === "string") {
    const encoded = textEncoder.encode(value);
    pushLengthPrefixed(parts, encoded.length, 0xa0, FIVE_BITS, 0xd9, 0xda, 0xdb, "string");
    parts.push(encoded);
    return;
  }
  if (value instanceof Uint8Array) {
    // bin has no fix form, so pass a fixLimit of 0 to skip straight to bin 8.
    pushLengthPrefixed(parts, value.length, 0x00, 0, 0xc4, 0xc5, 0xc6, "byte string");
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    pushLengthPrefixed(parts, value.length, 0x90, FOUR_BITS, null, 0xdc, 0xdd, "array");
    for (const item of value) encodeInto(item, parts);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new Error("msgpack: only plain objects can be encoded");
  }
  const entries = Object.entries(value);
  pushLengthPrefixed(parts, entries.length, 0x80, FOUR_BITS, null, 0xde, 0xdf, "map");
  for (const [key, entry] of entries) {
    encodeInto(key, parts);
    encodeInto(entry, parts);
  }
}

/**
 * Normalize an action before encoding, matching the reference implementation exactly:
 *
 *  - drop `undefined`-valued keys, so an omitted optional field does not become a `nil` entry that
 *    changes the map length (and therefore the hash);
 *  - promote integers outside int32/uint32 range to bigint, so they encode as a fixed-width uint64
 *    instead of silently degrading to float64.
 */
export function prepareAction(value: MsgpackValue): MsgpackValue {
  if (typeof value === "number" && Number.isInteger(value) && (value >= THIRTY_TWO_BITS || value < -THIRTY_ONE_BITS)) {
    return BigInt(value);
  }
  if (Array.isArray(value)) return value.map(prepareAction);
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    const out: { [key: string]: MsgpackValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = prepareAction(entry);
    }
    return out;
  }
  return value;
}
