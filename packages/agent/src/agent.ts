import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Signal, SignalVenueT } from "@sigmax/shared";
import { RealCdr, type CdrPort } from "@sigmax/cdr";
import type { AgentConfig } from "./config.js";
import { ZeroExExecutor } from "./executor.js";
import { ChainlinkPriceSource } from "./price.js";
import { HyperliquidExecutor } from "./hyperliquid/executor.js";
import { HyperliquidPriceSource } from "./hyperliquid/price.js";
import type { Executor, PriceSource } from "./ports.js";
import { RegistrySubscriberSource } from "./subscribers.js";
import { LicenseDiscovery } from "./licenses.js";
import { PositionStore } from "./state.js";
import { AgentLogger } from "./logger.js";
import { SignalPipeline } from "./pipeline.js";
import { TpSlMonitor } from "./tpsl.js";

/**
 * Wires the real ports from config into the pipeline + TP/SL monitor. The lean daemon: in-memory
 * store, interval poller, real CDR/registry/0x/executeSwap integrations. No Redis/BullMQ/Supabase.
 */
export class Agent {
  readonly store: PositionStore;
  readonly pipeline: SignalPipeline;
  readonly monitor: TpSlMonitor;
  private readonly cdr: CdrPort;
  private readonly licenses: LicenseDiscovery;
  private readonly logger: AgentLogger;

  constructor(cfg: AgentConfig, logger = new AgentLogger()) {
    this.logger = logger;
    // CONFIDENTIAL SIGNAL PATH: every signal is CDR threshold-encrypted on Story. MULTI-LEADER: each
    // leader mints an operator license to the agent's CDR wallet; we discover those licenses from the
    // wallet's holdings (seeded with any configured one) and present them on decrypt so the on-chain
    // read condition matches the right one per vault.
    const cdrAddress = privateKeyToAccount(cfg.cdrKey).address;
    this.licenses = new LicenseDiscovery({
      storyRpcUrl: cfg.storyRpcUrl,
      owner: cdrAddress,
      seed: cfg.operatorLicenseTokenId !== undefined ? [cfg.operatorLicenseTokenId] : [],
    });
    const licenses = this.licenses;
    this.cdr = new RealCdr({
      privateKey: cfg.cdrKey,
      rpcUrl: cfg.storyRpcUrl,
      apiUrl: cfg.storyApiUrl,
      getLicenseTokenIds: () => licenses.get(),
    });
    // EXECUTION VENUES: a signal now carries its own `venue`, so we build EVERY venue this agent is
    // configured for and route per-signal. Hyperliquid builds when its per-trade cap is set (or it's the
    // default venue); Arbitrum builds when its RPC + factory are present. At least one is required.
    const executors: Partial<Record<SignalVenueT, Executor>> = {};
    const prices: Partial<Record<SignalVenueT, PriceSource>> = {};

    if (cfg.executionVenue === "hyperliquid" || cfg.hyperliquidPerTradeCap !== undefined) {
      const hlCfg = {
        testnet: cfg.hyperliquidTestnet,
        tokens: cfg.hyperliquidTokens ?? {}, // optional legacy address→symbol override; symbols resolve live
        perTradeCap: cfg.hyperliquidPerTradeCap ?? 0n,
      };
      // The HL agent key signs orders; falls back to AGENT_PK if a dedicated key isn't set.
      executors.hyperliquid = new HyperliquidExecutor({ agentPk: cfg.hyperliquidAgentPk ?? cfg.agentPk, ...hlCfg });
      prices.hyperliquid = new HyperliquidPriceSource(hlCfg);
    }
    if (cfg.liquidityRpcUrl && cfg.factoryAddress) {
      executors.arbitrum = new ZeroExExecutor({
        agentPk: cfg.agentPk,
        rpcUrl: cfg.liquidityRpcUrl,
        chainId: cfg.liquidityChainId,
        factoryAddress: cfg.factoryAddress,
        zeroExApiKey: cfg.zeroExApiKey,
      });
      prices.arbitrum = new ChainlinkPriceSource({ rpcUrl: cfg.liquidityRpcUrl, chainId: cfg.liquidityChainId });
    }
    if (!executors.hyperliquid && !executors.arbitrum) {
      throw new Error("no execution venue configured (set up hyperliquid and/or arbitrum)");
    }

    // Per-signal/per-position resolvers. A signal targeting a venue this agent isn't configured for
    // throws `venue_not_configured`, which the pipeline/monitor catch per-item and log as a skip.
    const executorFor = (v: SignalVenueT): Executor => {
      const e = executors[v];
      if (!e) throw new Error(`venue_not_configured: ${v}`);
      return e;
    };
    const priceFor = (v: SignalVenueT): PriceSource => {
      const p = prices[v];
      if (!p) throw new Error(`venue_not_configured: ${v}`);
      return p;
    };
    const subscribers = new RegistrySubscriberSource({
      storyRpcUrl: cfg.storyRpcUrl,
      registryAddress: cfg.registryAddress,
      followers: cfg.followers as Hex[],
      trustConfiguredFollowers: cfg.trustConfiguredFollowers,
    });
    this.store = new PositionStore(cfg.statePath);
    this.pipeline = new SignalPipeline({
      cdr: this.cdr,
      executorFor,
      subscribers,
      store: this.store,
      logger,
      defaultSlippageBps: cfg.defaultSlippageBps,
      persist: () => this.store.persist(), // per-follower durability against mid-fan-out crashes
    });
    this.monitor = new TpSlMonitor({
      executorFor,
      priceFor,
      store: this.store,
      logger,
      pollMs: cfg.pollMs,
      defaultSlippageBps: cfg.defaultSlippageBps,
    });
  }

  /** Boot: discover held licenses, restore non-secret state + re-derive secret TP/SL, start monitor. */
  async start(): Promise<void> {
    const tokenIds = await this.licenses.refresh();
    this.logger.info("licenses_discovered", { count: String(tokenIds.length) });
    const { restored, dropped } = await this.store.reconcile(this.cdr);
    this.logger.info("reconciled", { restored: String(restored), dropped: String(dropped) });
    this.monitor.start();
  }

  /**
   * Encrypt + publish a signal to CDR (server-only; called by the HTTP publish endpoint). The
   * plaintext signal stays in memory and is never logged. Returns the on-chain CDR vault uuid.
   */
  async publishSignal(signal: Signal): Promise<{ uuid: number }> {
    return this.cdr.publishSignal(signal);
  }

  /** Process one signal vault (the demo trigger; production swaps this for an event watcher). */
  async processSignal(uuid: number): Promise<void> {
    // Pick up any license a leader minted to us since boot, so we can decrypt their fresh vault.
    await this.licenses.refresh();
    await this.pipeline.processSignal(uuid);
    await this.store.persist();
  }

  /** Graceful shutdown: stop the poller and persist non-secret state. */
  async stop(): Promise<void> {
    this.monitor.stop();
    await this.store.persist();
  }
}
