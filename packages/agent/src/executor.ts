import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { COPY_VAULT_ABI, COPY_VAULT_FACTORY_ABI, ERC20_ABI } from "./abis.js";
import type { Executor } from "./ports.js";

/** ENTRY sizing: `balance * sizeBps / 10000`, clamped to `perTradeCap` (doc 31 — clamp, don't skip). */
export function entryAmount(balance: bigint, sizeBps: number, perTradeCap: bigint): bigint {
  const sized = (balance * BigInt(sizeBps)) / 10_000n;
  return sized > perTradeCap ? perTradeCap : sized;
}

interface ZeroExQuote {
  transaction: { to: Hex; data: Hex };
  minBuyAmount: string;
}

export interface ZeroExExecutorConfig {
  agentPk: Hex;
  rpcUrl: string;
  chainId: number;
  factoryAddress: Hex;
  zeroExApiKey?: string;
  zeroExBaseUrl?: string; // override for tests; default api.0x.org
}

/**
 * Real executor: resolves the follower's vault, fetches a 0x Swap API v2 quote (doc 41), and calls
 * CopyVault.executeSwap signed by AGENT_PK. `minOut` is taken from the quote and re-enforced on-chain.
 */
export class ZeroExExecutor implements Executor {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly cfg: ZeroExExecutorConfig;
  private readonly baseUrl: string;

  constructor(cfg: ZeroExExecutorConfig) {
    this.cfg = cfg;
    this.baseUrl = cfg.zeroExBaseUrl ?? "https://api.0x.org";
    this.account = privateKeyToAccount(cfg.agentPk);
    const chain = defineChain({
      id: cfg.chainId,
      name: `chain-${cfg.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    });
    const transport = http(cfg.rpcUrl);
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
  }

  async vaultOf(follower: Hex): Promise<Hex> {
    return this.publicClient.readContract({
      address: this.cfg.factoryAddress,
      abi: COPY_VAULT_FACTORY_ABI,
      functionName: "vaultOf",
      args: [follower],
    });
  }

  async balanceOf(vault: Hex, token: string): Promise<bigint> {
    return this.publicClient.readContract({
      address: token as Hex, // arbitrum tokens are EVM addresses (validated upstream by the signal schema)
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [vault],
    });
  }

  async perTradeCap(vault: Hex): Promise<bigint> {
    return this.publicClient.readContract({
      address: vault,
      abi: COPY_VAULT_ABI,
      functionName: "perTradeCap",
    });
  }

  private async quote(args: {
    vault: Hex;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    slippageBps: number;
  }): Promise<{ router: Hex; swapData: Hex; minOut: bigint }> {
    const params = new URLSearchParams({
      chainId: String(this.cfg.chainId),
      sellToken: args.tokenIn,
      buyToken: args.tokenOut,
      sellAmount: args.amountIn.toString(),
      taker: args.vault,
      slippageBps: String(args.slippageBps),
    });
    const res = await fetch(`${this.baseUrl}/swap/allowance-holder/quote?${params}`, {
      headers: {
        "0x-version": "v2",
        ...(this.cfg.zeroExApiKey ? { "0x-api-key": this.cfg.zeroExApiKey } : {}),
      },
    });
    if (!res.ok) throw new Error(`0x quote failed: ${res.status} ${res.statusText}`);
    const q = (await res.json()) as ZeroExQuote;
    if (!q.transaction?.to || !q.transaction?.data || !q.minBuyAmount) {
      throw new Error("0x quote missing transaction/minBuyAmount");
    }
    return { router: q.transaction.to, swapData: q.transaction.data, minOut: BigInt(q.minBuyAmount) };
  }

  async quoteAndSwap(args: {
    vault: Hex;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    slippageBps: number;
    // Accepted for interface parity with the HL venue; the 0x/Arbitrum path stays market-only for now
    // (limit-entry support via 0x is future work). maxEntryPrice is intentionally ignored here.
    maxEntryPrice?: bigint;
  }): Promise<{ txHash: Hex; received: bigint }> {
    const { router, swapData, minOut } = await this.quote(args);
    const balBefore = await this.balanceOf(args.vault, args.tokenOut);

    const { request } = await this.publicClient.simulateContract({
      account: this.account,
      address: args.vault,
      abi: COPY_VAULT_ABI,
      functionName: "executeSwap",
      args: [args.tokenIn as Hex, args.amountIn, args.tokenOut as Hex, minOut, router, swapData],
    });
    const txHash = await this.walletClient.writeContract(request);
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    const balAfter = await this.balanceOf(args.vault, args.tokenOut);
    return { txHash, received: balAfter - balBefore };
  }
}
