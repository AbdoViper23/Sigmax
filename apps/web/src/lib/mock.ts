// Mock data for the disconnected / unconfigured fallback (follower page only) and the multi-leader
// marketplace browse experience. Everything that has a real on-chain source is derived in the hooks
// — these are just placeholders so the UI renders before contracts/wallet are wired (Phase 1).
import type { PositionRow } from "@/components/sigmax/PositionsTable";
import type { Leader } from "@/lib/leaders";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const mockTx = async () => {
  await sleep(900);
};

export const mockStrategy = {
  monthlyPrice: "5",
};

export const mockSubscription = {
  active: true,
  expiry: new Date(Date.now() + 1000 * 60 * 60 * 24 * 18).toISOString(),
};

export const mockBalances = {
  walletUsdc: "2,430.55",
  vaultUsdc: "1,000.00",
};

export const mockVault = {
  address: "0x4f2b6E91c8aA3D5fEa17B2cE9C9d3aF8b2e1A0d3",
};

export const mockPositions: PositionRow[] = [
  {
    id: "p1",
    pair: "USDC → WETH",
    amountIn: "500.00 USDC",
    currentValue: "538.21 USDC",
    pnlPct: 7.64,
    pnlUsd: "+38.21",
    openedAt: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(),
    status: "open",
    txUrl: "https://arbiscan.io/tx/0xabc1",
  },
  {
    id: "p2",
    pair: "USDC → ARB",
    amountIn: "250.00 USDC",
    currentValue: "241.04 USDC",
    pnlPct: -3.58,
    pnlUsd: "-8.96",
    openedAt: new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString(),
    status: "open",
    txUrl: "https://arbiscan.io/tx/0xabc2",
  },
  {
    id: "p3",
    pair: "USDC → WBTC",
    amountIn: "300.00 USDC",
    currentValue: "327.40 USDC",
    pnlPct: 9.13,
    pnlUsd: "+27.40",
    openedAt: new Date(Date.now() - 1000 * 60 * 60 * 96).toISOString(),
    status: "closed",
    txUrl: "https://arbiscan.io/tx/0xabc3",
    closeReason: "TP",
  },
];

// ───────────────────────── multi-leader marketplace (Phase 1: mock) ─────────────────────────
// A browsable set of leaders so the marketplace renders without contracts. The wiring phase replaces
// `useLeaders()`'s body with a PlanCreated event scan; this list (and per-leader positions below) is
// the only thing that goes away. Ids are placeholder Hex strings — they're real route params today.
export const mockLeaders: Leader[] = [
  {
    id: "0xa1c0de00000000000000000000000000000000a1",
    leaderAddress: "0xA11ce0000000000000000000000000000000A11c",
    username: "momentum_alpha",
    displayName: "Momentum Alpha",
    monthlyPrice: "5",
    bio: "Trend-following spot rotations across blue-chip majors. Commit-before-outcome, every signal.",
    performance: {
      verifiedReturnPct: 42.6,
      winRatePct: 71,
      maxDrawdownPct: null,
      closedTrades: 38,
    },
    subscribers: 128,
  },
  {
    id: "0xb2c0de00000000000000000000000000000000b2",
    leaderAddress: "0xB0b0000000000000000000000000000000000B0b",
    username: "steady_yield",
    displayName: "Steady Yield",
    monthlyPrice: "3",
    bio: "Low-volatility accumulation. Smaller swings, consistent compounding.",
    performance: {
      verifiedReturnPct: 18.4,
      winRatePct: 64,
      maxDrawdownPct: null,
      closedTrades: 52,
    },
    subscribers: 86,
  },
  {
    id: "0xc3c0de00000000000000000000000000000000c3",
    leaderAddress: "0xCa110000000000000000000000000000000000Ca",
    username: "deep_value",
    displayName: "Deep Value",
    monthlyPrice: "8",
    bio: "Contrarian entries on oversold majors. Patience over frequency.",
    performance: {
      verifiedReturnPct: -6.2,
      winRatePct: 48,
      maxDrawdownPct: null,
      closedTrades: 21,
    },
    subscribers: 34,
  },
  {
    id: "0xd4c0de00000000000000000000000000000000d4",
    leaderAddress: "0xDee0000000000000000000000000000000000Dee",
    username: "breakout_hunter",
    displayName: "Breakout Hunter",
    monthlyPrice: "6",
    bio: "Volatility-expansion entries. Tight risk, asymmetric upside.",
    performance: {
      verifiedReturnPct: 27.9,
      winRatePct: 58,
      maxDrawdownPct: null,
      closedTrades: 44,
    },
    subscribers: 61,
  },
  {
    id: "0xe5c0de00000000000000000000000000000000e5",
    leaderAddress: "0xEf00000000000000000000000000000000000Ef0",
    username: "fresh_desk",
    displayName: "Fresh Desk",
    monthlyPrice: "2",
    bio: "New leader building a track record. Fewer than 10 closed trades so far.",
    performance: {
      verifiedReturnPct: null,
      winRatePct: null,
      maxDrawdownPct: null,
      closedTrades: 4,
    },
    subscribers: 7,
  },
];

// ───────────────────────── seeded TEST leaders (always shown, flagged) ─────────────────────────
// Unlike `mockLeaders` (a disconnected-mode fallback), these are appended to the leaderboard EVEN when
// contracts are configured — useful for demoing the full marketplace + track-record UI against a live
// deployment that has no real leaders yet. Every one carries `flaggedForTesting: true`, so the UI
// renders a "Test" badge and never passes this off as a verified on-chain record. Ids use an 0xf…
// prefix so they can't collide with real PlanCreated strategy ids in the same list.
const hoursAgo = (h: number) => new Date(Date.now() - 1000 * 60 * 60 * h).toISOString();

const testPositionsAurora: PositionRow[] = [
  {
    id: "t1-1",
    pair: "USDC → WBTC",
    amountIn: "1,200.00 USDC",
    currentValue: "1,418.64 USDC",
    pnlPct: 18.22,
    pnlUsd: "+218.64",
    openedAt: hoursAgo(3),
    status: "open",
    txUrl: "https://arbiscan.io/tx/0xtest01",
  },
  {
    id: "t1-2",
    pair: "USDC → WETH",
    amountIn: "800.00 USDC",
    currentValue: "861.20 USDC",
    pnlPct: 7.65,
    pnlUsd: "+61.20",
    openedAt: hoursAgo(20),
    status: "open",
    txUrl: "https://arbiscan.io/tx/0xtest02",
  },
  {
    id: "t1-3",
    pair: "USDC → ARB",
    amountIn: "600.00 USDC",
    currentValue: "702.00 USDC",
    pnlPct: 17.0,
    pnlUsd: "+102.00",
    openedAt: hoursAgo(52),
    status: "closed",
    txUrl: "https://arbiscan.io/tx/0xtest03",
    closeReason: "TP",
  },
  {
    id: "t1-4",
    pair: "USDC → WBTC",
    amountIn: "1,000.00 USDC",
    currentValue: "1,134.00 USDC",
    pnlPct: 13.4,
    pnlUsd: "+134.00",
    openedAt: hoursAgo(96),
    status: "closed",
    txUrl: "https://arbiscan.io/tx/0xtest04",
    closeReason: "SIGNAL",
  },
];

const testPositionsNova: PositionRow[] = [
  {
    id: "t2-1",
    pair: "USDC → SOL",
    amountIn: "500.00 USDC",
    currentValue: "612.50 USDC",
    pnlPct: 22.5,
    pnlUsd: "+112.50",
    openedAt: hoursAgo(8),
    status: "open",
    txUrl: "https://arbiscan.io/tx/0xtest05",
  },
  {
    id: "t2-2",
    pair: "USDC → ARB",
    amountIn: "400.00 USDC",
    currentValue: "366.00 USDC",
    pnlPct: -8.5,
    pnlUsd: "-34.00",
    openedAt: hoursAgo(44),
    status: "closed",
    txUrl: "https://arbiscan.io/tx/0xtest06",
    closeReason: "SL",
  },
  {
    id: "t2-3",
    pair: "USDC → WETH",
    amountIn: "750.00 USDC",
    currentValue: "829.50 USDC",
    pnlPct: 10.6,
    pnlUsd: "+79.50",
    openedAt: hoursAgo(120),
    status: "closed",
    txUrl: "https://arbiscan.io/tx/0xtest07",
    closeReason: "TP",
  },
];

const testPositionsZephyr: PositionRow[] = [
  {
    id: "t3-1",
    pair: "USDC → WETH",
    amountIn: "300.00 USDC",
    currentValue: "289.50 USDC",
    pnlPct: -3.5,
    pnlUsd: "-10.50",
    openedAt: hoursAgo(14),
    status: "open",
    txUrl: "https://arbiscan.io/tx/0xtest08",
  },
  {
    id: "t3-2",
    pair: "USDC → WBTC",
    amountIn: "450.00 USDC",
    currentValue: "486.00 USDC",
    pnlPct: 8.0,
    pnlUsd: "+36.00",
    openedAt: hoursAgo(72),
    status: "closed",
    txUrl: "https://arbiscan.io/tx/0xtest09",
    closeReason: "TP",
  },
];

export const testLeaders: Leader[] = [
  {
    id: "0xf100de0000000000000000000000000000000f01",
    leaderAddress: "0xF100000000000000000000000000000000000F01",
    username: "aurora_test",
    displayName: "Aurora (Test)",
    monthlyPrice: "4",
    bio: "Seeded test leader — momentum rotations on majors. Use to demo the marketplace + track record.",
    performance: {
      verifiedReturnPct: 34.8,
      winRatePct: 68,
      maxDrawdownPct: -12.4,
      closedTrades: 31,
    },
    subscribers: 42,
    flaggedForTesting: true,
  },
  {
    id: "0xf200de0000000000000000000000000000000f02",
    leaderAddress: "0xF200000000000000000000000000000000000F02",
    username: "nova_test",
    displayName: "Nova (Test)",
    monthlyPrice: "7",
    bio: "Seeded test leader — higher-variance breakout entries. Fake data for UI/demo only.",
    performance: {
      verifiedReturnPct: 21.3,
      winRatePct: 55,
      maxDrawdownPct: -19.7,
      closedTrades: 27,
    },
    subscribers: 19,
    flaggedForTesting: true,
  },
  {
    id: "0xf300de0000000000000000000000000000000f03",
    leaderAddress: "0xF300000000000000000000000000000000000F03",
    username: "zephyr_test",
    displayName: "Zephyr (Test)",
    monthlyPrice: "3",
    bio: "Seeded test leader — conservative accumulation. Fake data for UI/demo only.",
    performance: {
      verifiedReturnPct: -4.1,
      winRatePct: 51,
      maxDrawdownPct: -9.2,
      closedTrades: 16,
    },
    subscribers: 8,
    flaggedForTesting: true,
  },
];

/** Per-leader closed/open positions, so each detail page shows a distinct track record. */
export const mockLeaderPositions: Record<string, PositionRow[]> = {
  "0xa1c0de00000000000000000000000000000000a1": mockPositions,
  "0xb2c0de00000000000000000000000000000000b2": mockPositions.slice(0, 2),
  "0xc3c0de00000000000000000000000000000000c3": [mockPositions[1]],
  "0xd4c0de00000000000000000000000000000000d4": mockPositions.slice(1),
  "0xe5c0de00000000000000000000000000000000e5": [],
  // Seeded test leaders — their histories render even against a live deployment.
  "0xf100de0000000000000000000000000000000f01": testPositionsAurora,
  "0xf200de0000000000000000000000000000000f02": testPositionsNova,
  "0xf300de0000000000000000000000000000000f03": testPositionsZephyr,
};
