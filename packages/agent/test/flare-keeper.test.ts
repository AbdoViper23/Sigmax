import { describe, it, expect, vi } from "vitest";
import { toFunctionSelector, type Account, type Hex } from "viem";
import { relayActionResult, describeRevert, type KeeperClients, type TeeActionResult } from "../src/flare/keeper.js";
import { encodeSwapAuths } from "../src/flare/process-signal.js";
import type { SwapAuth } from "../src/flare/swap-auth.js";

const VAULT_A = "0x3333333333333333333333333333333333333333" as const;
const VAULT_B = "0x4444444444444444444444444444444444444444" as const;
const NOW = 1_800_000_000;

function auth(over: Partial<SwapAuth> = {}): SwapAuth {
  return {
    vault: VAULT_A,
    tokenIn: "0x0b6A3645c240605887a5532109323A3E12273dc7",
    tokenOut: "0x1111111111111111111111111111111111111111",
    amountIn: 50_000_000n,
    minOut: 54_000_000n,
    router: "0x8D29b61C41CF318d15d031BE2928F79630e068e6",
    swapData: "0x38ed1739",
    signalId: `0x${"ab".repeat(32)}` as Hex,
    deadline: BigInt(NOW + 600),
    chainId: 114n,
    ...over,
  };
}

function actionResult(auths: SwapAuth[], over: Partial<TeeActionResult> = {}): TeeActionResult {
  return {
    resultData: encodeSwapAuths(auths),
    actionId: `0x${"11".repeat(32)}` as Hex,
    submissionTag: "sigmax-test",
    status: 1,
    signature: `0x${"22".repeat(65)}` as Hex,
    ...over,
  };
}

function makeClients(over: { write?: () => Promise<Hex>; simulate?: () => Promise<unknown> } = {}) {
  const writeContract = vi.fn(over.write ?? (async () => `0x${"ff".repeat(32)}` as Hex));
  const simulateContract = vi.fn(over.simulate ?? (async () => ({ result: 0n })));
  const clients = {
    publicClient: { simulateContract },
    walletClient: { writeContract, chain: undefined },
    account: { address: "0x9999999999999999999999999999999999999999" } as Account,
  } as unknown as KeeperClients;
  return { clients, writeContract, simulateContract };
}

const opts = { chainId: 114n, now: () => NOW };

describe("flare keeper", () => {
  it("submits one transaction per authorization, to that entry's own vault", async () => {
    const auths = [auth(), auth({ vault: VAULT_B })];
    const { clients, writeContract } = makeClients();

    const outcomes = await relayActionResult(clients, actionResult(auths), opts);

    expect(outcomes.map((o) => o.status)).toEqual(["submitted", "submitted"]);
    expect(writeContract).toHaveBeenCalledTimes(2);
    expect(writeContract.mock.calls[0]![0].address).toBe(VAULT_A);
    expect(writeContract.mock.calls[1]![0].address).toBe(VAULT_B);
  });

  it("passes the whole signed batch plus this vault's index, unmodified", async () => {
    const auths = [auth(), auth({ vault: VAULT_B })];
    const result = actionResult(auths);
    const { clients, writeContract } = makeClients();

    await relayActionResult(clients, result, opts);

    const [batch, index, actionId, tag, status, signature] = writeContract.mock.calls[1]![0].args;
    expect(batch).toHaveLength(2); // the full batch — the signature covers all of it
    expect(index).toBe(1n);
    expect(actionId).toBe(result.actionId);
    expect(tag).toBe(result.submissionTag);
    expect(status).toBe(1);
    expect(signature).toBe(result.signature);
  });

  it("simulates before sending, and skips the send when simulation reverts", async () => {
    const { clients, writeContract } = makeClients({
      simulate: async () => {
        throw new Error("execution reverted: BadTeeSignature()");
      },
    });

    const [outcome] = await relayActionResult(clients, actionResult([auth()]), opts);

    expect(outcome!.status).toBe("failed");
    expect(outcome!.reason).toMatch(/BadTeeSignature/);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("skips an expired authorization without spending gas", async () => {
    const { clients, writeContract, simulateContract } = makeClients();

    const [outcome] = await relayActionResult(clients, actionResult([auth({ deadline: BigInt(NOW - 1) })]), opts);

    expect(outcome).toMatchObject({ status: "skipped", reason: "authorization expired" });
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("skips an authorization minted for a different chain", async () => {
    const { clients, writeContract } = makeClients();

    const [outcome] = await relayActionResult(clients, actionResult([auth({ chainId: 42161n })]), opts);

    expect(outcome!.status).toBe("skipped");
    expect(outcome!.reason).toMatch(/chain/);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("skips a zero-amount authorization", async () => {
    const { clients, writeContract } = makeClients();

    const [outcome] = await relayActionResult(clients, actionResult([auth({ amountIn: 0n })]), opts);

    expect(outcome).toMatchObject({ status: "skipped", reason: "zero amountIn" });
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("keeps relaying the rest of the batch after one entry fails", async () => {
    let call = 0;
    const { clients } = makeClients({
      write: async () => {
        call++;
        if (call === 1) throw new Error("execution reverted: AuthAlreadyUsed()");
        return `0x${"ee".repeat(32)}` as Hex;
      },
    });

    const outcomes = await relayActionResult(clients, actionResult([auth(), auth({ vault: VAULT_B })]), opts);

    expect(outcomes[0]).toMatchObject({ status: "failed", vault: VAULT_A });
    expect(outcomes[1]).toMatchObject({ status: "submitted", vault: VAULT_B });
  });

  it("refuses to relay a non-success ActionResult", async () => {
    const { clients } = makeClients();

    await expect(relayActionResult(clients, actionResult([auth()], { status: 0 }), opts)).rejects.toThrow(
      /non-success/,
    );
  });

  it("relays an empty batch as a no-op", async () => {
    const { clients, writeContract } = makeClients();

    expect(await relayActionResult(clients, actionResult([]), opts)).toEqual([]);
    expect(writeContract).not.toHaveBeenCalled();
  });

  it("reports only the vault and revert reason — never strategy content", async () => {
    const { clients } = makeClients({
      write: async () => {
        throw new Error("execution reverted: MinOut()\n  raw: 0xdeadbeef");
      },
    });

    const [outcome] = await relayActionResult(clients, actionResult([auth()]), opts);

    expect(Object.keys(outcome!).sort()).toEqual(["index", "reason", "status", "vault"]);
    expect(outcome!.reason).not.toContain("0xdeadbeef"); // only the first line is kept
  });
});

/**
 * The selector table exists so a revert names the guard that fired instead of just "reverted". A wrong
 * entry is worse than no entry: it reports the wrong guard and sends you debugging the wrong thing.
 * One entry was in fact wrong (TeeAddressUnset carried a selector from an unrelated contract's
 * revert), so these are pinned against selectors computed from the signatures themselves.
 */
describe("vault error selectors", () => {
  const EXPECTED: Record<string, string> = {
    "MinOut()": "0x168f8aad",
    "SwapFailed()": "0x81ceff30",
    "BadTeeSignature()": "0xc6faa85f",
    "CapExceeded()": "0xa4875a49",
    "TokenNotWhitelisted()": "0xf84835a0",
    "RouterNotWhitelisted()": "0xb76b08ae",
    "AuthExpired()": "0xa4c91367",
    "AuthAlreadyUsed()": "0xae6a6625",
    "WrongVault()": "0xe224e0ca",
    "WrongChain()": "0x10dfc033",
    "BadStatus()": "0x5c975bda",
    "TeeAddressUnset()": "0x6c47fd6a",
    "NotOwner()": "0x30cd7471",
    "Paused()": "0x9e87fac8",
  };
  // Cross-checked against `forge inspect CopyVaultFlare errors`.

  it("match keccak256(signature)[0:4] for every CopyVaultFlare error", () => {
    for (const [sig, selector] of Object.entries(EXPECTED)) {
      expect(toFunctionSelector(sig), `${sig} selector`).toBe(selector);
    }
  });

  it("names the guard when the revert message carries its selector", () => {
    for (const [sig, selector] of Object.entries(EXPECTED)) {
      const name = sig.replace("()", "");
      const reason = describeRevert(`Execution reverted\n\nsignature: ${selector}\n`);
      expect(reason, `${sig} should be named`).toContain(name);
    }
  });
});
