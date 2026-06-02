import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { Agent } from "../src/agent.js";

// A minimal env for the Stage-A fast path: Hyperliquid venue + mock CDR + trusted follower.
const KEY = "0x" + "11".repeat(32);
const ADDR = "0x" + "aa".repeat(20);
const HL_ENV: NodeJS.ProcessEnv = {
  EXECUTION_VENUE: "hyperliquid",
  CDR_MODE: "mock",
  AGENT_PK: KEY,
  HYPERLIQUID_AGENT_PK: KEY,
  HYPERLIQUID_TOKENS: '{"0x0000000000000000000000000000000000000001":"HYPE","0x0000000000000000000000000000000000000002":"USDC"}',
  HYPERLIQUID_PER_TRADE_CAP: "1500000000",
  STORY_RPC_URL: "https://aeneid.storyrpc.io",
  REGISTRY_ADDRESS: ADDR,
  FOLLOWERS: ADDR,
  TRUST_CONFIGURED_FOLLOWERS: "true",
};

describe("Agent boot — Hyperliquid venue + mock CDR (Stage A wiring)", () => {
  it("parses the mock+HL config without needing CDR_KEY / STORY_API_URL", () => {
    const cfg = loadConfig(HL_ENV);
    expect(cfg.executionVenue).toBe("hyperliquid");
    expect(cfg.cdrMode).toBe("mock");
    expect(cfg.trustConfiguredFollowers).toBe(true);
    expect(cfg.cdrKey).toBeUndefined();
  });

  it("constructs the Agent (MockCdr + HL executor) without throwing or any network call", () => {
    const agent = new Agent(loadConfig(HL_ENV));
    expect(agent.pipeline).toBeDefined();
    expect(agent.monitor).toBeDefined();
  });

  it("still requires CDR_KEY + STORY_API_URL when cdrMode=real", () => {
    expect(() => loadConfig({ ...HL_ENV, CDR_MODE: "real" })).toThrow();
  });
});
