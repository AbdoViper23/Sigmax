import type { Hex } from "viem";
import type { Signal } from "@sigmax/shared";
import { RealCdr } from "@sigmax/cdr";
import type { AgentConfig } from "./config.js";
import { ZeroExExecutor } from "./executor.js";
import { ChainlinkPriceSource } from "./price.js";
import { RegistrySubscriberSource } from "./subscribers.js";
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
  private readonly cdr: RealCdr;
  private readonly logger: AgentLogger;

  constructor(cfg: AgentConfig, logger = new AgentLogger()) {
    this.logger = logger;
    this.cdr = new RealCdr({
      privateKey: cfg.cdrKey,
      rpcUrl: cfg.storyRpcUrl,
      apiUrl: cfg.storyApiUrl,
      ipId: cfg.strategyIpId,
      leader: cfg.strategyIpId, // unused on the read path; reads only need the operator license + ipId
      operatorLicenseTokenId: cfg.operatorLicenseTokenId,
    });
    const executor = new ZeroExExecutor({
      agentPk: cfg.agentPk,
      rpcUrl: cfg.liquidityRpcUrl,
      chainId: cfg.liquidityChainId,
      factoryAddress: cfg.factoryAddress,
      zeroExApiKey: cfg.zeroExApiKey,
    });
    const price = new ChainlinkPriceSource({ rpcUrl: cfg.liquidityRpcUrl, chainId: cfg.liquidityChainId });
    const subscribers = new RegistrySubscriberSource({
      storyRpcUrl: cfg.storyRpcUrl,
      registryAddress: cfg.registryAddress,
      followers: cfg.followers as Hex[],
    });
    this.store = new PositionStore(cfg.statePath);
    this.pipeline = new SignalPipeline({
      cdr: this.cdr,
      executor,
      subscribers,
      store: this.store,
      logger,
      defaultSlippageBps: cfg.defaultSlippageBps,
      persist: () => this.store.persist(), // per-follower durability against mid-fan-out crashes
    });
    this.monitor = new TpSlMonitor({
      executor,
      price,
      store: this.store,
      logger,
      pollMs: cfg.pollMs,
      defaultSlippageBps: cfg.defaultSlippageBps,
    });
  }

  /** Boot: restore non-secret state and re-derive secret TP/SL from CDR, then start the monitor. */
  async start(): Promise<void> {
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
    await this.pipeline.processSignal(uuid);
    await this.store.persist();
  }

  /** Graceful shutdown: stop the poller and persist non-secret state. */
  async stop(): Promise<void> {
    this.monitor.stop();
    await this.store.persist();
  }
}
