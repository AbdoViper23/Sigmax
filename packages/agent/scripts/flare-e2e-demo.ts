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
import { EnclaveSignalSealer, ProxyEnclaveKeySource, normalizePublicKey } from "@sigmax/enclave-crypto";
import type { Signal } from "@sigmax/shared";
import { relayActionResult, type TeeActionResult } from "../src/flare/keeper.js";

const RPC = process.env.FLARE_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc";

const coston2 = defineChain({
  id: 114,
  name: "Flare Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

/** Per-instruction fee charged by TeeExtensionRegistry (fce-sign's DefaultFee). */
const INSTRUCTION_FEE_WEI = BigInt(process.env.FEE_WEI ?? "1000000000000");

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
    // The faucet mint is rate-limited (reverts THROTTLED), so only reach for it when we actually
    // need more than we hold — a repeat demo run should not depend on the faucet at all.
    const held = await publicClient.readContract({ address: TEST_USD, abi: ERC20, functionName: "balanceOf", args: [account.address] });
    if (held < 1_000_000n) {
      await send("mint testUSD", await walletClient.writeContract({ address: TEST_USD, abi: ERC20, functionName: "mint" }));
    } else {
      console.log(`  holding ${formatUnits(held, 6)} testUSD already — skipping the faucet`);
    }
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

  const cdr = new EnclaveSignalSealer(new ProxyEnclaveKeySource(proxyUrl));
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

  // The registry routes each instruction to a RANDOM machine registered for the extension. A
  // simulated TEE mints a fresh identity on every restart, so old registrations linger in
  // PRODUCTION pointing at keys nobody holds — and an instruction routed to one is never answered.
  // Republish until we're routed to the live machine. (Set LIVE_TEE_ID to enable; without it we
  // just take whatever routing we get.)
  // Each restart leaves another dead registration behind, so the odds decay; 20 attempts keeps the
  // demo reliable even with several stale machines. The production fix is for the sender to request
  // getRandomTeeIds(extensionId, n) and fan the instruction out to every machine.
  /*
   * Derive the live identity from the key the proxy is publishing right now. It used to come from
   * `LIVE_TEE_ID` in .env, and that is wrong by construction: a simulated TEE mints a new identity on
   * every restart, so the pinned value goes stale the first time the stack comes back up — and then
   * EVERY dispatch compares unequal and is reported as a misroute. That is what produced the
   * "six consecutive publishes all routed to the retired machine" reading; the routing was fine, the
   * yardstick was dead. `LIVE_TEE_ID` stays honoured as an explicit override.
   */
  const liveTee = (process.env.LIVE_TEE_ID ?? (await deriveLiveTeeId(proxyUrl)))
    ?.toLowerCase()
    .replace(/^0x/, "");
  const publishOnce = async () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const receipt = await send(
        `publishSignal (attempt ${attempt})`,
        await walletClient.writeContract({
          address: sender,
          abi: SENDER_ABI,
          functionName: "publishSignal",
          args: [strategyId, "", ciphertext],
          // TeeExtensionRegistry charges a per-instruction fee, forwarded through publishSignal.
          // Matches fce-sign's DefaultFee (go/tools/pkg/utils/instructions.go); override with FEE_WEI.
          value: INSTRUCTION_FEE_WEI,
        }),
      );
      if (!liveTee || routedToLiveMachine(receipt.logs, liveTee)) return receipt;
      console.log("  routed to a stale TEE registration — republishing");
    }
    throw new Error("never routed to the live TEE machine in 20 attempts");
  };
  let publishReceipt = await publishOnce();

  // ------------------------------------------------------------ 5. TEE result
  step(5, "Waiting for the TEE to decrypt and return a signed authorization");
  let result: TeeActionResult | undefined;
  for (let round = 1; round <= 3 && !result; round++) {
    const instructionId = extractInstructionId(publishReceipt.logs);
    console.log(`  instruction ${instructionId}`);
    try {
      result = await pollForResult(proxyUrl, instructionId, 150_000);
    } catch (e) {
      if (!(e instanceof PendingTimeout) || round === 3) throw e;
      // The enclave's first scan of this strategy overran the node's action timeout. Its subscriber
      // cache is warm now, so a second signal is answered promptly.
      console.log("\n  still pending — republishing now that the enclave has scanned this strategy");
      publishReceipt = await publishOnce();
    }
  }
  if (!result) throw new Error("no signed authorization");
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
 * `TeeInstructionsSent(uint256 indexed extensionId, bytes32 indexed instructionId, uint256 indexed …)`
 * — emitted by TeeExtensionRegistry when publishSignal routes the ciphertext. The instruction id is
 * the second indexed topic, and it is the key the proxy files the result under.
 */
const TEE_INSTRUCTIONS_SENT_TOPIC = "0xf770e69a9fc05b7180797556ec4cedb6108ce2c56ffa76c84aa087efeb5e6963";

/** The event payload carries the routed teeIds; look for the live one rather than ABI-decoding. */
/** The address the running enclave's published key resolves to — what a dispatch is compared against. */
async function deriveLiveTeeId(proxyUrl: string): Promise<string | undefined> {
  try {
    const uncompressed = normalizePublicKey(await new ProxyEnclaveKeySource(proxyUrl).fetchPublicKey());
    const body = uncompressed.length === 65 ? uncompressed.slice(1) : uncompressed;
    return `0x${keccak256(body).slice(-40)}`;
  } catch {
    return undefined; // unreadable → publish once and take whatever routing we get
  }
}

function routedToLiveMachine(logs: readonly { topics: readonly Hex[]; data: Hex }[], liveTee: string): boolean {
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() === TEE_INSTRUCTIONS_SENT_TOPIC) {
      return log.data.toLowerCase().includes(liveTee);
    }
  }
  return false;
}

function extractInstructionId(logs: readonly { topics: readonly Hex[] }[]): Hex {
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() === TEE_INSTRUCTIONS_SENT_TOPIC && log.topics[2]) {
      return log.topics[2];
    }
  }
  throw new Error("publishSignal did not emit TeeInstructionsSent — was the extension id set?");
}

/** Poll the ext-proxy for the ActionResult of a specific instruction. 404 = not processed yet. */
async function pollForResult(proxyUrl: string, instructionId: Hex, timeoutMs = 240_000): Promise<TeeActionResult> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${proxyUrl}/action/result/${instructionId}`);
      if (res.ok) {
        const body = (await res.json()) as RawResponse;
        const r = body.result;
        // FCC status: 0 = error (terminal), 1 = success, >= 2 = still working. The handler scans
        // subscription logs in 30-block windows, so a pending status here is normal — keep waiting.
        if (r?.status === 0) throw new Error(`the TEE rejected the signal: ${r.log ?? "no reason given"}`);
        if (r?.status === 1) {
          return {
            resultData: (r.data ?? "0x") as Hex,
            actionId: r.id as Hex,
            submissionTag: r.submissionTag ?? "",
            status: r.status,
            signature: body.signature as Hex,
          };
        }
      } else if (res.status !== 404) {
        lastError = `proxy returned ${res.status}`;
      }
    } catch (e) {
      // A status-0 result is terminal — don't keep polling through the timeout.
      if (e instanceof Error && e.message.startsWith("the TEE rejected")) throw e;
      lastError = e instanceof Error ? e.message : String(e);
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new PendingTimeout(`no successful ActionResult within ${timeoutMs / 1000}s${lastError ? ` (last: ${lastError})` : ""}`);
}

/**
 * The result never reached success in time. Usually the enclave's first subscriber scan overran the
 * node's action timeout; its cache is warm afterwards, so republishing is the right response.
 */
class PendingTimeout extends Error {}

interface RawResponse {
  result?: { id?: string; submissionTag?: string; status: number; log?: string; data?: string };
  signature?: string;
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
