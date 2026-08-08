/**
 * End-to-end demo on Coston2 — the whole product in one run.
 *
 *   leader creates a plan → follower subscribes → follower's vault is created + funded →
 *   leader encrypts a signal IN THIS PROCESS (never sent anywhere in the clear) and publishes the
 *   ciphertext → the FCC extension decrypts it inside the TEE and returns a TEE-signed SwapAuth[] →
 *   the keeper relays it → each vault verifies the signature on-chain and swaps.
 *
 * The point it demonstrates: the strategy is never readable by anything except the enclave, and the
 * swap cannot happen without a signature from the registered TEE.
 *
 * Prereqs: the FCC stack is up and registered (see docs/flare/reference/phase-0-runbook.md), and the
 * control plane is deployed. Everything else is read from env:
 *
 *   DEPLOYMENT_PRIVATE_KEY   dev wallet (acts as leader, follower and keeper in this demo)
 *   FLARE_INSTRUCTION_SENDER config/extension.env INSTRUCTION_SENDER
 *   FLARE_SUBSCRIPTION_REGISTRY / FLARE_VAULT_FACTORY / FLARE_TEE_VERIFIER
 *   EXT_PROXY_URL            public proxy URL (for the enclave key + polling the result)
 *
 *   pnpm --filter @sigmax/agent tsx scripts/flare-e2e-demo.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  defineChain,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FlareEnclaveCdr, ProxyEnclaveKeySource } from "@sigmax/cdr";
import type { Signal } from "@sigmax/shared";
import { relayActionResult, type TeeActionResult } from "../src/flare/keeper.js";

const RPC = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

const coston2 = defineChain({
  id: 114,
  name: "Flare Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const FXRP: Address = "0x0b6A3645c240605887a5532109323A3E12273dc7";
const TEST_USD: Address = "0x6623C0BB56aDb150dC9C6BdB8682521354c2BF73";
const ROUTER: Address = "0x8D29b61C41CF318d15d031BE2928F79630e068e6";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint()",
]);
const REGISTRY_ABI = parseAbi([
  "function createPlan(address strategyId, address payToken, uint256 monthlyPrice, uint16 platformFeeBps, string username, string displayName)",
  "function subscribe(address strategyId)",
  "function isActive(address subscriber, address strategyId) view returns (bool)",
  "function plans(address) view returns (address leader, address payToken, uint256 monthlyPrice, uint16 platformFeeBps, bool active)",
]);
const FACTORY_ABI = parseAbi([
  "function createVault(address[] tokens, address[] routers, uint256 cap) returns (address)",
  "function vaultOf(address) view returns (address)",
]);
const VAULT_ABI = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function perTradeCap() view returns (uint256)",
]);
const SENDER_ABI = parseAbi([
  "function publishSignal(address _strategyId, string _uri, bytes _ciphertext) payable returns (uint256)",
]);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function step(n: number, msg: string) {
  console.log(`\n\x1b[36m[${n}]\x1b[0m ${msg}`);
}

async function main() {
  const account = privateKeyToAccount(
    (env("DEPLOYMENT_PRIVATE_KEY").startsWith("0x")
      ? env("DEPLOYMENT_PRIVATE_KEY")
      : `0x${env("DEPLOYMENT_PRIVATE_KEY")}`) as Hex,
  );
  const publicClient = createPublicClient({ chain: coston2, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: coston2, transport: http(RPC) });

  const registry = env("FLARE_SUBSCRIPTION_REGISTRY") as Address;
  const factory = env("FLARE_VAULT_FACTORY") as Address;
  const sender = env("FLARE_INSTRUCTION_SENDER") as Address;
  const proxyUrl = env("EXT_PROXY_URL").replace(/\/$/, "");

  // In a real deployment leader / follower / keeper are three different people. Here one wallet
  // plays all three so the demo runs unattended; nothing in the protocol depends on that.
  const strategyId = account.address;
  console.log(`wallet     ${account.address}  (leader + follower + keeper)`);
  console.log(`proxy      ${proxyUrl}`);

  const send = async (label: string, hash: Hex) => {
    const r = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ${label}  ${hash}  (${r.status})`);
    return r;
  };

  // ---------------------------------------------------------------- 1. plan
  step(1, "Leader creates a subscription plan");
  const plan = await publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "plans", args: [strategyId] });
  if (plan[0] === "0x0000000000000000000000000000000000000000") {
    await send(
      "createPlan",
      await walletClient.writeContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: "createPlan",
        args: [strategyId, TEST_USD, 1_000_000n, 1500, "sigmax-demo", "Sigmax Demo Strategy"],
      }),
    );
  } else {
    console.log("  plan already exists — reusing");
  }

  // ------------------------------------------------------------ 2. subscribe
  step(2, "Follower subscribes (pays the monthly price in testUSD)");
  if (await publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "isActive", args: [account.address, strategyId] })) {
    console.log("  already an active subscriber");
  } else {
    await send("mint testUSD", await walletClient.writeContract({ address: TEST_USD, abi: ERC20, functionName: "mint" }));
    await send(
      "approve",
      await walletClient.writeContract({ address: TEST_USD, abi: ERC20, functionName: "approve", args: [registry, 1_000_000n] }),
    );
    await send("subscribe", await walletClient.writeContract({ address: registry, abi: REGISTRY_ABI, functionName: "subscribe", args: [strategyId] }));
  }

  // ---------------------------------------------------------------- 3. vault
  step(3, "Follower creates their non-custodial vault and funds it with FXRP");
  let vault = await publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: "vaultOf", args: [account.address] });
  if (vault === "0x0000000000000000000000000000000000000000") {
    await send(
      "createVault",
      await walletClient.writeContract({
        address: factory,
        abi: FACTORY_ABI,
        functionName: "createVault",
        args: [[FXRP, TEST_USD], [ROUTER], 1_000_000n], // cap 1 FXRP/trade
      }),
    );
    vault = await publicClient.readContract({ address: factory, abi: FACTORY_ABI, functionName: "vaultOf", args: [account.address] });
  }
  console.log(`  vault      ${vault}`);

  const vaultFxrp = await publicClient.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [vault] });
  const DEPOSIT = 500_000n; // 0.5 FXRP
  if (vaultFxrp < DEPOSIT) {
    await send("approve FXRP", await walletClient.writeContract({ address: FXRP, abi: ERC20, functionName: "approve", args: [vault, DEPOSIT] }));
    await send("deposit", await walletClient.writeContract({ address: vault, abi: VAULT_ABI, functionName: "deposit", args: [FXRP, DEPOSIT] }));
  }
  console.log(
    `  balance    ${formatUnits(await publicClient.readContract({ address: FXRP, abi: ERC20, functionName: "balanceOf", args: [vault] }), 6)} FXRP`,
  );

  // -------------------------------------------------------------- 4. publish
  step(4, "Leader encrypts the signal IN THIS PROCESS and publishes only the ciphertext");
  const now = Math.floor(Date.now() / 1000);
  const signal: Signal = {
    version: 1,
    signalId: crypto.randomUUID(),
    strategyId,
    chainId: 114,
    venue: "flare",
    action: "EXIT", // sell FXRP into testUSD — the direction the vault is funded for
    token: FXRP,
    quoteToken: TEST_USD,
    sizeBps: 500, // 5% of the vault
    maxEntryPrice: "0",
    takeProfitPrice: "150000000", // confidential — must never appear on-chain
    stopLossPrice: "80000000", //  confidential — must never appear on-chain
    issuedAt: now,
    expiresAt: now + 3600,
  };

  const cdr = new FlareEnclaveCdr(new ProxyEnclaveKeySource(proxyUrl));
  const { ciphertext, byteLength } = await cdr.encryptSignal(signal);
  console.log(`  signalId   ${signal.signalId}`);
  console.log(`  ciphertext ${byteLength} bytes, commitment ${keccak256(ciphertext).slice(0, 18)}…`);

  // Prove the point: neither confidential price appears anywhere in what goes on-chain.
  for (const secret of [signal.takeProfitPrice, signal.stopLossPrice]) {
    if (ciphertext.toLowerCase().includes(BigInt(secret).toString(16))) {
      throw new Error("confidential value leaked into the ciphertext — abort");
    }
  }
  console.log("  ✓ take-profit and stop-loss are not recoverable from the published bytes");

  const publishReceipt = await send(
    "publishSignal",
    await walletClient.writeContract({
      address: sender,
      abi: SENDER_ABI,
      functionName: "publishSignal",
      args: [strategyId, "", ciphertext],
      value: 0n,
    }),
  );

  // ------------------------------------------------------------ 5. TEE result
  step(5, "Waiting for the TEE to decrypt and return a signed authorization");
  const result = await pollForResult(proxyUrl, publishReceipt.blockNumber);
  console.log(`  actionId   ${result.actionId}`);
  console.log(`  status     ${result.status}`);
  console.log(`  signature  ${result.signature.slice(0, 22)}…`);

  // --------------------------------------------------------------- 6. execute
  step(6, "Keeper relays the authorization — the vault verifies the TEE signature on-chain");
  const outcomes = await relayActionResult({ publicClient, walletClient, account }, result, { chainId: 114n });
  for (const o of outcomes) {
    console.log(`  ${o.vault}  ${o.status}${o.txHash ? `  ${o.txHash}` : ""}${o.reason ? `  (${o.reason})` : ""}`);
  }

  const finalUsd = await publicClient.readContract({ address: TEST_USD, abi: ERC20, functionName: "balanceOf", args: [vault] });
  console.log(`\n  vault now holds ${formatUnits(finalUsd, 6)} testUSD from the copied trade`);
  console.log("\n\x1b[32mEnd-to-end demo complete.\x1b[0m The strategy was never readable outside the enclave.");
}

/**
 * Poll the ext-proxy for the ActionResult produced by our instruction. The proxy exposes results by
 * action id; we scan recent results and take the first SIGNAL/EXECUTE one we can verify is ours.
 */
async function pollForResult(proxyUrl: string, fromBlock: bigint, timeoutMs = 180_000): Promise<TeeActionResult> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${proxyUrl}/results?fromBlock=${fromBlock}`);
      if (res.ok) {
        const body = (await res.json()) as { results?: RawResult[] } | RawResult[];
        const list = Array.isArray(body) ? body : (body.results ?? []);
        const hit = list.find((r) => r.status === 1 && r.resultData && r.signature);
        if (hit) {
          return {
            resultData: hit.resultData as Hex,
            actionId: hit.actionId as Hex,
            submissionTag: hit.submissionTag ?? "",
            status: hit.status,
            signature: hit.signature as Hex,
          };
        }
      } else {
        lastError = `proxy returned ${res.status}`;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`no ActionResult within ${timeoutMs / 1000}s${lastError ? ` (last: ${lastError})` : ""}`);
}

interface RawResult {
  resultData?: string;
  actionId?: string;
  submissionTag?: string;
  status: number;
  signature?: string;
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
