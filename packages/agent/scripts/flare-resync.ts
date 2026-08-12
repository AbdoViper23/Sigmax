/**
 * Resync the deployment after an enclave restart — the one command to run before a demo.
 *
 * THE PROBLEM IT SOLVES. A simulated enclave mints a fresh identity every time it starts. Every vault
 * verifies authorizations against a stored `teeAddress`, so after a restart the whole system is
 * silently dead: the enclave signs correctly, the keeper relays correctly, and every swap reverts with
 * `BadTeeSignature`. Nothing in the UI explains why. This script finds that drift and fixes what it
 * can, then prints exactly which env values are stale.
 *
 * WHAT IT DOES NOT DO: guess. Every action is reported with the before/after value, and anything it
 * cannot fix without a redeploy is called out rather than papered over.
 *
 * Env:
 *   EXT_PROXY_URL             the enclave proxy (to read its current identity)
 *   FLARE_VAULT_FACTORY       CopyVaultFlareFactory
 *   DEPLOYMENT_PRIVATE_KEY    the factory admin / vault owner (only needed to APPLY fixes)
 *   APPLY=1                   perform the fixes; without it this is a read-only report
 *
 *   pnpm --filter @sigmax/agent exec tsx scripts/flare-resync.ts
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ProxyEnclaveKeySource, normalizePublicKey } from "@sigmax/enclave-crypto";

const RPC = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

const coston2 = defineChain({
  id: 114,
  name: "Flare Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

/** The mutable-teeAddress factory. `admin()` is absent on the pre-rotation deployment. */
const FACTORY_ABI = parseAbi([
  "function teeAddress() view returns (address)",
  "function admin() view returns (address)",
  "function vaultOf(address) view returns (address)",
  "function setTeeAddress(address)",
]);

const VAULT_ABI = parseAbi([
  "function teeAddress() view returns (address)",
  "function owner() view returns (address)",
  "function setTeeAddress(address)",
]);

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const OFF = "\x1b[0m";

const ok = (m: string) => console.log(`${GREEN}✓${OFF} ${m}`);
const warn = (m: string) => console.log(`${YELLOW}!${OFF} ${m}`);
const bad = (m: string) => console.log(`${RED}✗${OFF} ${m}`);
const dim = (m: string) => console.log(`${DIM}  ${m}${OFF}`);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

/** The address an FCC machine's public key resolves to — the identity a vault ecrecovers to. */
function addressFromPublicKey(publicKeyHex: string): Address {
  const uncompressed = normalizePublicKey(publicKeyHex);
  const body = uncompressed.length === 65 ? uncompressed.slice(1) : uncompressed;
  const hash = keccak256(body);
  return `0x${hash.slice(-40)}` as Address;
}

async function main(): Promise<void> {
  const apply = process.env.APPLY === "1";
  const proxyUrl = env("EXT_PROXY_URL").replace(/\/$/, "");
  const factory = env("FLARE_VAULT_FACTORY") as Address;

  const publicClient = createPublicClient({ chain: coston2, transport: http(RPC) });

  console.log(`\n${apply ? "APPLYING FIXES" : "REPORT ONLY (set APPLY=1 to fix)"}\n`);
  console.log(`proxy    ${proxyUrl}`);
  console.log(`factory  ${factory}\n`);

  // ---------------------------------------------------------------- 1. the live enclave identity
  let liveTee: Address;
  try {
    const publicKey = await new ProxyEnclaveKeySource(proxyUrl).fetchPublicKey();
    liveTee = addressFromPublicKey(publicKey);
    ok(`enclave is up, identity ${liveTee}`);
  } catch (e) {
    bad(`cannot reach the enclave proxy: ${e instanceof Error ? e.message : String(e)}`);
    dim("Nothing else can be checked without it. Bring the stack up first:");
    dim("  cd fce-sigmax && bash scripts/start-services.sh && bash scripts/post-build.sh");
    process.exit(1);
  }

  // ---------------------------------------------------------------- 2. the factory
  const factoryTee = await publicClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: "teeAddress",
  });

  // A pre-rotation factory has an immutable teeAddress and no `admin()`. Detecting that here is the
  // difference between one transaction and a redeploy that strands existing vaults.
  let rotatable = true;
  let admin: Address = "0x0000000000000000000000000000000000000000";
  try {
    admin = await publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: "admin" });
  } catch {
    rotatable = false;
  }

  const account = process.env.DEPLOYMENT_PRIVATE_KEY
    ? privateKeyToAccount(process.env.DEPLOYMENT_PRIVATE_KEY as Hex)
    : undefined;
  const walletClient = account
    ? createWalletClient({ account, chain: coston2, transport: http(RPC) })
    : undefined;

  if (factoryTee.toLowerCase() === liveTee.toLowerCase()) {
    ok("factory already points at the live enclave");
  } else if (!rotatable) {
    bad(`factory teeAddress is ${factoryTee}, live enclave is ${liveTee} — and this factory CANNOT rotate`);
    dim("This is the pre-rotation deployment with an `immutable` teeAddress. Redeploy the factory:");
    dim(`  TEE_ADDRESS=${liveTee} forge script script/DeployFlareControlPlane.s.sol --broadcast \\`);
    dim("    --rpc-url https://coston2-api.flare.network/ext/C/rpc");
    dim("Then update FLARE_VAULT_FACTORY / VITE_FLARE_VAULT_FACTORY / SIGMAX_VAULT_FACTORY.");
    warn("A redeploy moves `vaultOf` to a new contract — existing vaults keep their funds but the app");
    warn("stops finding them. Withdraw from any funded vault BEFORE redeploying.");
  } else if (!apply) {
    warn(`factory teeAddress ${factoryTee} != live enclave ${liveTee} — run with APPLY=1 to rotate`);
    dim(`admin is ${admin}`);
  } else if (!walletClient || !account) {
    bad("cannot rotate: DEPLOYMENT_PRIVATE_KEY is not set");
  } else if (admin.toLowerCase() !== account.address.toLowerCase()) {
    bad(`cannot rotate: admin is ${admin}, your key is ${account.address}`);
  } else {
    const hash = await walletClient.writeContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: "setTeeAddress",
      args: [liveTee],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    ok(`factory rotated to ${liveTee} (${hash})`);
  }

  // ---------------------------------------------------------------- 3. this operator's own vault
  if (account) {
    const vault = await publicClient.readContract({
      address: factory,
      abi: FACTORY_ABI,
      functionName: "vaultOf",
      args: [account.address],
    });

    if (vault === "0x0000000000000000000000000000000000000000") {
      dim(`no vault for ${account.address} on this factory`);
    } else {
      const vaultTee = await publicClient.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "teeAddress",
      });
      if (vaultTee.toLowerCase() === liveTee.toLowerCase()) {
        ok(`vault ${vault} already trusts the live enclave`);
      } else if (!apply) {
        warn(`vault ${vault} trusts ${vaultTee} — stale. Run with APPLY=1 to repoint it`);
      } else if (walletClient) {
        // Owner-only in the contract. A follower does this from the UI; here it is the demo operator.
        const hash = await walletClient.writeContract({
          address: vault,
          abi: VAULT_ABI,
          functionName: "setTeeAddress",
          args: [liveTee],
        });
        await publicClient.waitForTransactionReceipt({ hash });
        ok(`vault repointed to the live enclave (${hash})`);
      }
    }
  } else {
    dim("set DEPLOYMENT_PRIVATE_KEY to also check your own vault");
  }

  // ---------------------------------------------------------------- 4. env drift
  console.log("\nenv values to confirm:");
  const expectations: [string, string | undefined, string][] = [
    ["VITE_FLARE_PROXY_URL", process.env.VITE_FLARE_PROXY_URL, proxyUrl],
    ["VITE_FLARE_VAULT_FACTORY", process.env.VITE_FLARE_VAULT_FACTORY, factory],
    ["SIGMAX_VAULT_FACTORY", process.env.SIGMAX_VAULT_FACTORY, factory],
  ];
  for (const [name, actual, expected] of expectations) {
    if (!actual) dim(`${name} is unset here — check apps/web/.env and fce-sigmax/.env`);
    else if (actual.replace(/\/$/, "").toLowerCase() !== expected.toLowerCase()) {
      warn(`${name}=${actual} but expected ${expected}`);
    } else ok(`${name} matches`);
  }
  dim("SIGMAX_SUBS_FROM_BLOCK must be the registry's deploy block — 0 blows the instruction timeout.");

  // ---------------------------------------------------------------- 5. Hyperliquid readiness
  console.log("\nhyperliquid venue:");
  try {
    const res = await fetch(`${proxyUrl}/state`);
    const state = (await res.json()) as { state?: { hasKey?: boolean; hlAgentMasterPubkey?: string } };
    if (state.state?.hasKey) {
      ok(`agent key injected, master pubkey ${state.state.hlAgentMasterPubkey}`);
    } else {
      warn("no agent key in the enclave — Hyperliquid signals will be rejected");
      dim("  pnpm --filter @sigmax/agent exec tsx scripts/hl-inject-key.ts");
      dim("The key is memory-only, so this is required after EVERY restart.");
    }
  } catch {
    warn("could not read /state");
  }
  if (!process.env.SIGMAX_HL_PER_TRADE_CAP || process.env.SIGMAX_HL_PER_TRADE_CAP === "0") {
    warn("SIGMAX_HL_PER_TRADE_CAP is 0/unset — the venue is disabled by design (fails closed)");
  }

  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
