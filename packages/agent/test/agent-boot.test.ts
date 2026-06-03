import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { Agent } from "../src/agent.js";

// Minimal live-CDR env: Hyperliquid venue + CDR creds + a trusted follower. Construction must not
// touch the network — RealCdr / LicenseDiscovery only build their clients; the first chain call
// happens later (start()/publishSignal).
const KEY = "0x" + "11".repeat(32);
const ADDR = "0x" + "aa".repeat(20);
const HL_ENV: NodeJS.ProcessEnv = {
  EXECUTION_VENUE: "hyperliquid",
  AGENT_PK: KEY,
  CDR_KEY: KEY,
  HYPERLIQUID_AGENT_PK: KEY,
  STORY_API_URL: "http://localhost:1317",
  HYPERLIQUID_TOKENS: '{"0x0000000000000000000000000000000000000001":"HYPE","0x0000000000000000000000000000000000000002":"USDC"}',
  HYPERLIQUID_PER_TRADE_CAP: "1500000000",
  STORY_RPC_URL: "https://aeneid.storyrpc.io",
  REGISTRY_ADDRESS: ADDR,
  FOLLOWERS: ADDR,
  TRUST_CONFIGURED_FOLLOWERS: "true",
};

describe("Agent boot — Hyperliquid venue + live CDR wiring", () => {
  it("parses the HL + CDR config", () => {
    const cfg = loadConfig(HL_ENV);
    expect(cfg.executionVenue).toBe("hyperliquid");
    expect(cfg.trustConfiguredFollowers).toBe(true);
    expect(cfg.cdrKey).toBe(KEY);
  });

  it("constructs the Agent (RealCdr + HL executor) without throwing or any network call", () => {
    const agent = new Agent(loadConfig(HL_ENV));
    expect(agent.pipeline).toBeDefined();
    expect(agent.monitor).toBeDefined();
  });

  it("requires the CDR decrypt key (CDR_KEY) and Story-API URL (STORY_API_URL)", () => {
    const noKey = { ...HL_ENV };
    delete noKey.CDR_KEY;
    expect(() => loadConfig(noKey)).toThrow();

    const noApi = { ...HL_ENV };
    delete noApi.STORY_API_URL;
    expect(() => loadConfig(noApi)).toThrow();
  });
});
