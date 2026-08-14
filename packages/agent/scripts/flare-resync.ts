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
 *   FLARE_EXTENSION_ID        our extension id (decimal), to inspect its registered machines
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

/** FlareTeeManager (FCC diamond) — the registry that decides whether an instruction reaches us. */
const TEE_MANAGER = (process.env.FLARE_TEE_MANAGER ??
  "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE") as Address;

/*
 * `pause` is the one that retires a stale identity. It is NOT in `ITeeMachineRegistry` — that interface
 * is view-only, which is why this looked unfixable at first. The deployed manager does have it; the real
 * ABI lives in the Go module cache, under
 * `go-flare-common@<version>/pkg/contracts/tee/machinemanager/machinemanager.abi`, and carries nine
 * write functions, `pause(address)` among them. Callable by the machine's owner.
 */
const TEE_MANAGER_ABI = parseAbi([
  "function getActiveTeeMachines(uint256 extensionId) view returns (address[] teeIds, string[] urls)",
  "function getTeeMachineStatus(address teeId) view returns (uint8)",
  "function pause(address teeId)",
]);

/** ITeeMachineRegistry.TeeStatus. Only PRODUCTION (2) receives dispatched instructions. */
const TEE_STATUS = ["NONE", "INITIALIZED", "PRODUCTION", "SUSPENDED", "PAUSED", "BANNED"] as const;

/** The public FTDC proxies, for cross-checking an instruction that never showed up. */
const FTDC_PROXIES = [
  "https://tee-proxy-coston2-1.flare.rocks",
  "https://tee-proxy-coston2-2.flare.rocks",
];

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
  const account = process.env.DEPLOYMENT_PRIVATE_KEY
    ? privateKeyToAccount(process.env.DEPLOYMENT_PRIVATE_KEY as Hex)
    : undefined;
  const walletClient = account
    ? createWalletClient({ account, chain: coston2, transport: http(RPC) })
    : undefined;

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

  // ------------------------------------------------- 1b. the machines registered for this extension
  /*
   * An on-chain dispatch is NOT delivery. A dispatch picks ONE machine from those registered under the
   * extension, and providers then POST straight to that machine's registered URL. So a single stale
   * registration alongside a live one turns into intermittent, apparently random silence — every other
   * signal is routed to a machine that no longer exists.
   *
   * That is what `flare-e2e-demo.ts` works around by republishing up to 20 times until it happens to be
   * routed to the live machine. The actual fix is to PAUSE the stale identity, and this check is what
   * makes the situation visible instead of guessable.
   */
  const extensionId = process.env.FLARE_EXTENSION_ID;
  if (!extensionId) {
    dim("set FLARE_EXTENSION_ID to also audit the machines registered for this extension");
  } else {
    try {
      const [teeIds, urls] = await publicClient.readContract({
        address: TEE_MANAGER,
        abi: TEE_MANAGER_ABI,
        functionName: "getActiveTeeMachines",
        args: [BigInt(extensionId)],
      });

      if (teeIds.length === 0) {
        bad(`extension ${extensionId} has NO registered machines — nothing can be dispatched to`);
        dim("  cd fce-sigmax && bash scripts/post-build.sh");
      } else {
        const statuses = await Promise.all(
          teeIds.map((id) =>
            publicClient
              .readContract({
                address: TEE_MANAGER,
                abi: TEE_MANAGER_ABI,
                functionName: "getTeeMachineStatus",
                args: [id],
              })
              .catch(() => 0),
          ),
        );

        const live = teeIds.filter((id, i) => statuses[i] === 2 && id.toLowerCase() === liveTee.toLowerCase());
        for (const [i, id] of teeIds.entries()) {
          const status = TEE_STATUS[statuses[i] ?? 0] ?? "UNKNOWN";
          const isLive = id.toLowerCase() === liveTee.toLowerCase();
          const line = `${id}  ${status.padEnd(12)} ${urls[i] ?? ""}`;
          if (isLive && statuses[i] === 2) ok(`machine ${line}  ← the running enclave`);
          else if (isLive) warn(`machine ${line}  ← the running enclave, but not PRODUCTION`);
          else warn(`machine ${line}  ← STALE (a dispatch routed here is never answered)`);
        }

        /*
         * Retire the stale identities. This is not a tidy-up: with two PRODUCTION machines registered,
         * dispatch picks one at random and the retired one answers nothing — measured on Coston2, six
         * consecutive publishes all routed to the dead machine. Pausing is what makes routing
         * deterministic, so APPLY=1 does it rather than printing instructions nobody can follow (the
         * scaffold ships no pause command).
         */
        const stale = teeIds.filter((id) => id.toLowerCase() !== liveTee.toLowerCase());
        if (stale.length > 0) {
          bad(`${teeIds.length} machines are active for this extension — dispatch picks one at random`);
          if (!apply) {
            warn(`run with APPLY=1 to pause ${stale.length} stale ${stale.length === 1 ? "identity" : "identities"}`);
          } else if (!walletClient) {
            bad("cannot pause: DEPLOYMENT_PRIVATE_KEY is not set");
          } else {
            for (const id of stale) {
              try {
                const hash = await walletClient.writeContract({
                  address: TEE_MANAGER,
                  abi: TEE_MANAGER_ABI,
                  functionName: "pause",
                  args: [id],
                });
                await publicClient.waitForTransactionReceipt({ hash });
                ok(`paused stale machine ${id} (${hash})`);
              } catch (e) {
                bad(`could not pause ${id}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
                dim("Only the machine's owner can pause it — check DEPLOYMENT_PRIVATE_KEY.");
              }
            }
          }
        }
        if (live.length === 0) {
          bad("the running enclave is NOT an active PRODUCTION machine — instructions will not arrive");
          dim("  cd fce-sigmax && bash scripts/post-build.sh   # re-register this identity");
        }
      }
    } catch (e) {
      warn(`could not read the machine registry: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /*
   * Availability freshness is a delivery requirement we cannot read from the registry interface: a
   * machine must have passed an availability check within the last ~6 hours to be dispatched to. There
   * is no public getter for it, so this is a reminder rather than a check — and it is the most common
   * reason a correctly-registered PRODUCTION machine still receives nothing after sitting idle.
   */
  dim("Delivery also requires an availability check newer than ~6h. A machine left idle overnight");
  dim("stops receiving instructions even while it still reads as PRODUCTION.");

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

  // ---------------------------------------------------------------- 6. where to look next
  console.log("\nif an instruction dispatches but never arrives:");
  dim("A dispatch event is not delivery. Providers POST to the machine's registered URL (:6664");
  dim("/instruction) — the proxy does not pull from the indexer, so nothing retries for you.");
  dim(`  proxy /info                     ${proxyUrl}/info`);
  dim(`  per-instruction status          ${proxyUrl}/action/status/<epoch>/<id>`);
  dim("  indexer health                  GET :6661/ready   (503 = genuinely behind)");
  for (const p of FTDC_PROXIES) dim(`  public FTDC proxy               ${p}`);
  dim("A 404 there does not mean the proxy is down — for a recent action it usually means the");
  dim("instruction never reached it, which points back at machine status or availability above.");

  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
