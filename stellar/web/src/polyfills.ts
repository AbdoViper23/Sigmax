// stellar-sdk uses Node's Buffer. Imported first from main.tsx so it is in place before the SDK loads.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
