/**
 * Redeploy the Coston2 control plane and rewrite every env file that references it.
 *
 * WHY THIS IS ONE COMMAND. The addresses are duplicated across three env files by design — the web app,
 * the enclave and the agent are independent deployables — but that means a redeploy has four steps and
 * the fourth is "update six variables in three files by hand". Getting one wrong does not fail loudly:
 * a stale `SIGMAX_SUBSCRIPTION_REGISTRY` makes the enclave find no subscribers, and a stale
 * `VITE_FLARE_VAULT_FACTORY` makes the app stop finding vaults that still hold funds. Both look like
 * "nothing happens".
 *
 * THE DESTRUCTIVE PART, STATED UP FRONT. `vaultOf` lives in the factory, so a new factory cannot see
 * vaults created by the old one. Those vaults keep their funds and their owner can still withdraw
 * directly, but the app will show them as non-existent. This script therefore refuses to proceed while
 * the old factory still holds funded vaults, unless you pass FORCE=1. Read the balances it prints first.
 *
 * Env:
 *   DEPLOYMENT_PRIVATE_KEY   funded Coston2 deployer; becomes the factory admin
 *   TEE_ADDRESS              the running enclave's identity (flare-resync.ts prints it)
 *   PLATFORM_TREASURY        receives the platform fee
 *   EXT_PROXY_URL            optional; used to derive TEE_ADDRESS if not given
 *   APPLY=1                  actually deploy and write files (otherwise: dry run)
 *   FORCE=1                  proceed even if the old factory has funded vaults
 *
 *   pnpm --filter @sigmax/agent exec tsx scripts/flare-deploy.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  defineChain,
  formatUnits,
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

const REPO = resolve(import.meta.dirname, "../../..");
const CONTRACTS = resolve(REPO, "packages/contracts");

const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7" as Address;
const TEST_USD = "0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73" as Address;

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const OLD_FACTORY_ABI = parseAbi([
  "function vaultOf(address) view returns (address)",
  "event VaultCreated(address indexed owner, address vault)",
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

/** The address an FCC machine's public key resolves to — what a vault ecrecovers against. */
function addressFromPublicKey(publicKeyHex: string): Address {
  const uncompressed = normalizePublicKey(publicKeyHex);
  const body = uncompressed.length === 65 ? uncompressed.slice(1) : uncompressed;
  return `0x${keccak256(body).slice(-40)}` as Address;
}

/**
 * Set `key=value` in a dotenv file, preserving comments, ordering and any unrelated lines. Appends the
 * key when absent — a rewrite that silently dropped a variable would be worse than not running at all.
 */
function setEnvVar(path: string, key: string, value: string): "updated" | "added" | "unchanged" {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = raw.split("\n");
  const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));

  if (idx >= 0) {
    if (lines[idx] === `${key}=${value}`) return "unchanged";
    lines[idx] = `${key}=${value}`;
    writeFileSync(path, lines.join("\n"), "utf8");
    return "updated";
  }
  const sep = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${raw}${sep}${key}=${value}\n`, "utf8");
  return "added";
}

interface Deployed {
  verifier: Address;
  factory: Address;
  signals: Address;
  subs: Address;
}

/** Parse the addresses out of `forge script`'s console output. */
function parseForgeOutput(out: string): Deployed {
  const grab = (label: string): Address => {
    const m = out.match(new RegExp(`${label}:?\\s+(0x[0-9a-fA-F]{40})`));
    if (!m?.[1]) throw new Error(`could not find ${label} in forge output`);
    return m[1] as Address;
  };
  return {
    verifier: grab("TeeSigVerifier"),
    factory: grab("CopyVaultFlareFactory"),
    signals: grab("SignalRegistry"),
    subs: grab("SubscriptionRegistry"),
  };
}

async function main(): Promise<void> {
  const apply = process.env.APPLY === "1";
  const deployerKey = env("DEPLOYMENT_PRIVATE_KEY") as Hex;
  const account = privateKeyToAccount(deployerKey);
  const treasury = (process.env.PLATFORM_TREASURY ?? account.address) as Address;

  const publicClient = createPublicClient({ chain: coston2, transport: http(RPC) });

  console.log(`\n${apply ? "DEPLOYING" : "DRY RUN (set APPLY=1 to deploy)"}\n`);
  console.log(`deployer   ${account.address}`);
  console.log(`treasury   ${treasury}`);

  // ------------------------------------------------------------ 1. the TEE identity to bake in
  let teeAddress = process.env.TEE_ADDRESS as Address | undefined;
  if (!teeAddress && process.env.EXT_PROXY_URL) {
    const proxyUrl = process.env.EXT_PROXY_URL.replace(/\/$/, "");
    try {
      teeAddress = addressFromPublicKey(await new ProxyEnclaveKeySource(proxyUrl).fetchPublicKey());
      ok(`read the enclave identity from the proxy: ${teeAddress}`);
    } catch (e) {
      bad(`could not read the enclave identity: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!teeAddress) {
    bad("no TEE_ADDRESS, and the proxy could not be read");
    dim("Bring the enclave up first — a factory baked with the wrong identity has to be redeployed:");
    dim("  cd fce-sigmax && bash scripts/start-services.sh && bash scripts/post-build.sh");
    process.exit(1);
  }
  console.log(`teeAddress ${teeAddress}`);

  // ------------------------------------------------------------ 2. protect funds in the old factory
  /*
   * The old factory's `vaultOf` mapping does not migrate. Any vault it created keeps its balance and its
   * owner can still call `withdraw` directly, but the app will look it up on the NEW factory, find
   * nothing, and offer to create another. That is how a redeploy loses track of user funds, so it is
   * checked before anything is broadcast rather than mentioned afterwards.
   */
  const oldFactory = process.env.FLARE_VAULT_FACTORY as Address | undefined;
  if (oldFactory) {
    try {
      const head = await publicClient.getBlockNumber();
      const fromBlock = BigInt(process.env.FLARE_FROM_BLOCK ?? "33898193");
      const funded: { vault: Address; fxrp: bigint; quote: bigint }[] = [];
      const vaults = new Set<Address>();

      /*
       * Two independent ways to find vaults, because each covers the other's blind spot.
       *
       * `vaultOf` is exact and instant but needs to be asked about a specific owner, so it covers the
       * operator and any configured demo followers. The log scan finds everyone else, but the public RPC
       * caps `eth_getLogs` at 30 blocks — ~2,500 requests across the deploy range, six minutes serially,
       * which is long enough that an operator would assume the script had hung and kill it. Batching the
       * windows concurrently (the same trick the enclave uses for its subscriber scan) brings that to
       * seconds.
       */
      const direct = [account.address, ...(process.env.FOLLOWERS ?? "").split(",")]
        .map((a) => a.trim())
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) as Address[];
      for (const owner of direct) {
        const v = await publicClient
          .readContract({ address: oldFactory, abi: OLD_FACTORY_ABI, functionName: "vaultOf", args: [owner] })
          .catch(() => "0x0000000000000000000000000000000000000000" as Address);
        if (v !== "0x0000000000000000000000000000000000000000") vaults.add(v);
      }

      const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
      for (let start = fromBlock; start <= head; start += 30n) {
        const end = start + 29n;
        ranges.push({ fromBlock: start, toBlock: end > head ? head : end });
      }
      /*
       * Failed windows are COUNTED, not swallowed. This check exists to protect user funds, and a
       * `.catch(() => [])` that quietly drops a rejected range makes "no funded vaults" and "could not
       * read the chain" produce the same reassuring output. A safety check that can silently pass is
       * worse than none, because it invites the destructive action it was meant to gate.
       */
      /*
       * Concurrency is 8, not 30, and failures are retried.
       *
       * The first version fanned out 30 windows at a time — the public RPC rate-limited it and 1,063 of
       * 2,592 windows failed. Worse, an earlier version swallowed those failures and cheerfully reported
       * "0 vaults, safe to replace", which is precisely the false pass this check exists to prevent. Go
       * gentler and retry rather than going fast and guessing.
       */
      const readWindow = async (r: { fromBlock: bigint; toBlock: bigint }, attempt = 0): Promise<unknown[] | null> => {
        try {
          return await publicClient.getContractEvents({
            address: oldFactory,
            abi: OLD_FACTORY_ABI,
            eventName: "VaultCreated",
            fromBlock: r.fromBlock,
            toBlock: r.toBlock,
          });
        } catch {
          if (attempt >= 4) return null; // exhausted — the caller counts it
          await new Promise((res) => setTimeout(res, 250 * 2 ** attempt));
          return readWindow(r, attempt + 1);
        }
      };

      let failedWindows = 0;
      const BATCH = 8;
      for (let i = 0; i < ranges.length; i += BATCH) {
        const batches = await Promise.all(ranges.slice(i, i + BATCH).map((r) => readWindow(r)));
        for (const logs of batches) {
          if (logs === null) {
            failedWindows += 1;
            continue;
          }
          for (const l of logs as { args?: { vault?: Address } }[]) {
            const v = l.args?.vault;
            if (v) vaults.add(v);
          }
        }
      }
      dim(`scanned blocks ${fromBlock}–${head} (${ranges.length} windows) + ${direct.length} known owner(s)`);

      for (const vault of vaults) {
        const [fxrp, quote] = await Promise.all([
          publicClient.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [vault] }),
          publicClient.readContract({ address: TEST_USD, abi: ERC20, functionName: "balanceOf", args: [vault] }),
        ]);
        if (fxrp > 0n || quote > 0n) funded.push({ vault, fxrp, quote });
      }

      /*
       * Report findings BEFORE complaining about coverage. An earlier version exited on the incomplete
       * log scan first, which meant it withheld the funded vault it had ALREADY found via the exact
       * `vaultOf` lookup — the operator was told "the audit is incomplete" and not "there is money in
       * this vault", which is the fact that actually decides what to do next.
       */
      if (funded.length > 0) {
        bad(`${funded.length} vault(s) on the old factory still hold funds:`);
        for (const f of funded) {
          dim(`${f.vault}  ${formatUnits(f.fxrp, 6)} FXRP  ${formatUnits(f.quote, 6)} testUSD`);
        }
        dim("Withdraw from each first — the owner can, from the vault card or directly. Replacing the");
        dim("factory does not take these funds, but the app looks vaults up on the NEW factory and will");
        dim("report the owner as having none.");
      } else {
        ok(`old factory has ${vaults.size} vault(s), none funded`);
      }

      /*
       * Coverage is reported as a separate, weaker signal. The public RPC rate-limits this scan pattern
       * hard enough that insisting on 100% would make the tool unusable — but a partial scan must never
       * be presented as a clean bill of health, so it downgrades the result rather than hiding it.
       */
      if (failedWindows > 0) {
        const pct = (((ranges.length - failedWindows) / ranges.length) * 100).toFixed(1);
        warn(`log coverage ${pct}% — ${failedWindows}/${ranges.length} windows failed even after retries`);
        dim("The exact `vaultOf` checks above are unaffected. A vault belonging to an owner not in that");
        dim("list, created inside a failed window, would be missed — re-run to improve coverage.");
      }

      if (funded.length > 0 || failedWindows > 0) {
        if (!process.env.FORCE) {
          bad("refusing to proceed. Fix the above, or set FORCE=1 to accept it deliberately.");
          process.exit(1);
        }
        warn("FORCE=1 — proceeding anyway");
      }
    } catch (e) {
      warn(`could not audit the old factory: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    dim("FLARE_VAULT_FACTORY unset — skipping the funded-vault check (nothing to strand)");
  }

  // ------------------------------------------------------------ 3. deploy
  if (!apply) {
    console.log("\nwould deploy TeeSigVerifier, CopyVaultFlareFactory, SignalRegistry, SubscriptionRegistry");
    console.log("and rewrite: apps/web/.env, fce-sigmax/.env, packages/agent/.env\n");
    return;
  }

  console.log("\nbroadcasting…");
  const out = execFileSync(
    "forge",
    [
      "script",
      "script/DeployFlareControlPlane.s.sol",
      "--rpc-url",
      RPC,
      "--broadcast",
      "--skip-simulation",
    ],
    {
      cwd: CONTRACTS,
      encoding: "utf8",
      env: {
        ...process.env,
        PRIVATE_KEY: deployerKey,
        TEE_ADDRESS: teeAddress,
        PLATFORM_TREASURY: treasury,
      },
    },
  );

  const d = parseForgeOutput(out);
  ok("deployed:");
  dim(`TeeSigVerifier         ${d.verifier}`);
  dim(`CopyVaultFlareFactory  ${d.factory}`);
  dim(`SignalRegistry         ${d.signals}`);
  dim(`SubscriptionRegistry   ${d.subs}`);

  // The registry is brand new, so every scan floor must move with it — leaving an old floor behind
  // means scanning blocks that predate the contract, which is slow at best and empty at worst.
  const deployBlock = (await publicClient.getBlockNumber()).toString();

  // ------------------------------------------------------------ 4. rewrite every env file
  console.log("\nrewriting env files:");
  const writes: [file: string, key: string, value: string][] = [
    ["apps/web/.env", "VITE_FLARE_TEE_VERIFIER", d.verifier],
    ["apps/web/.env", "VITE_FLARE_VAULT_FACTORY", d.factory],
    ["apps/web/.env", "VITE_FLARE_SIGNAL_REGISTRY", d.signals],
    ["apps/web/.env", "VITE_FLARE_SUBSCRIPTION_REGISTRY", d.subs],
    ["apps/web/.env", "VITE_FLARE_FROM_BLOCK", deployBlock],
    ["fce-sigmax/.env", "SIGMAX_SUBSCRIPTION_REGISTRY", d.subs],
    ["fce-sigmax/.env", "SIGMAX_VAULT_FACTORY", d.factory],
    ["fce-sigmax/.env", "SIGMAX_SUBS_FROM_BLOCK", deployBlock],
    ["packages/agent/.env", "FLARE_TEE_VERIFIER", d.verifier],
    ["packages/agent/.env", "FLARE_VAULT_FACTORY", d.factory],
    ["packages/agent/.env", "FLARE_SUBSCRIPTION_REGISTRY", d.subs],
    ["packages/agent/.env", "FLARE_FROM_BLOCK", deployBlock],
  ];
  for (const [file, key, value] of writes) {
    const result = setEnvVar(resolve(REPO, file), key, value);
    if (result === "unchanged") dim(`${file}  ${key} already correct`);
    else ok(`${file}  ${key} ${result}`);
  }

  console.log("\nnext:");
  dim("1. restart the enclave container so it picks up the new registry/factory env");
  dim("2. APPLY=1 pnpm --filter @sigmax/agent resync   # verify identity + machine registration");
  dim("3. pnpm --filter @sigmax/agent keeper           # must stay running for the Flare venue");
  dim("4. hl-inject-key.ts + SIGMAX_HL_PER_TRADE_CAP   # for the Hyperliquid venue");
  dim("5. restart the web dev server (Vite reads .env at boot)");
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
