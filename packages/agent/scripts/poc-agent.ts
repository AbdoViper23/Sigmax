/**
 * PoC — the agent loop end-to-end, fully in-memory (no chain, no creds).
 *
 * Uses the real SignalPipeline + TpSlMonitor with MockCdr and light fake ports so you can watch the
 * loop run deterministically: publish an ENTRY → decrypt → eligibility → swap → record position →
 * price crosses the (secret) take-profit → EXIT. Every printed line is the allowlist logger's output;
 * the take-profit/stop-loss values never appear. The live path swaps these fakes for the real ports.
 */
import type { Hex } from "viem";
import { MockCdr } from "@sigmax/cdr";
import { SignalSchema, ARBITRUM_ADDRESSES, type Signal } from "@sigmax/shared";
import {
  AgentLogger,
  PositionStore,
  SignalPipeline,
  TpSlMonitor,
  type Executor,
  type PriceSource,
  type SubscriberSource,
} from "../src/index.js";

const FOLLOWER = "0x00000000000000000000000000000000f0110001" as Hex;
const VAULT = "0x00000000000000000000000000000000Va017001" as Hex;
const STRATEGY = "0x77319B4031e6eF1250907aa00018B8B1c67a244b" as Hex;

const signal: Signal = SignalSchema.parse({
  signalId: "11111111-2222-3333-4444-555555555555",
  strategyId: STRATEGY,
  chainId: 42161,
  action: "ENTRY",
  token: ARBITRUM_ADDRESSES.weth,
  quoteToken: ARBITRUM_ADDRESSES.usdc,
  sizeBps: 5000, // 50% of balance
  takeProfitPrice: "300000000000", // $3000 (1e8) — SECRET, must never be printed
  stopLossPrice: "250000000000", // $2500 — SECRET
  issuedAt: 1_900_000_000,
  expiresAt: 1_900_086_400,
});

// --- fake ports (recording, no chain) ---
const fakeExecutor: Executor = {
  async vaultOf() {
    return VAULT;
  },
  async balanceOf() {
    return 1_000_000_000n; // 1000 USDC (6dp)
  },
  async perTradeCap() {
    return 1_000_000_000n;
  },
  async quoteAndSwap(a) {
    return { txHash: ("0x" + "ab".repeat(32)) as Hex, received: a.amountIn / 2n };
  },
};
const fakePrice: PriceSource = {
  async getPrice() {
    return 310000000000n; // $3100 — above the secret TP → triggers an exit
  },
};
const fakeSubs: SubscriberSource = {
  async isActive() {
    return true;
  },
  async listFollowers() {
    return [FOLLOWER];
  },
};

async function main() {
  const logger = new AgentLogger((line) => console.log(line));
  const store = new PositionStore();
  const cdr = new MockCdr({ hasLicense: true });

  const { uuid } = await cdr.publishSignal(signal);

  const pipeline = new SignalPipeline({
    cdr,
    executor: fakeExecutor,
    subscribers: fakeSubs,
    store,
    logger,
    defaultSlippageBps: 100,
  });
  console.log("— ENTRY —");
  await pipeline.processSignal(uuid);

  console.log("— TP/SL tick (price $3100 ≥ secret TP) —");
  const monitor = new TpSlMonitor({ executor: fakeExecutor, price: fakePrice, store, logger, pollMs: 10_000, defaultSlippageBps: 100 });
  await monitor.tick();

  console.log(`open positions remaining: ${store.all().length}`);
  console.log("PoC (agent) done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
