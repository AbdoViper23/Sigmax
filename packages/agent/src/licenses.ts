import { createPublicClient, defineChain, http, parseAbi, type Hex, type PublicClient } from "viem";
import { STORY_AENEID, STORY_AENEID_ADDRESSES } from "@sigmax/shared";

/** ERC-721 Transfer — used to find the LicenseTokens the agent currently holds. */
const LICENSE_TOKEN_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export interface LicenseDiscoveryConfig {
  storyRpcUrl: string;
  owner: Hex; // the agent's CDR wallet — the address leaders mint operator licenses to
  seed?: bigint[]; // pre-known license token ids (e.g. a configured OPERATOR_LICENSE_TOKEN_ID)
  licenseToken?: Hex; // default = STORY_AENEID_ADDRESSES.licenseToken
  chainId?: number; // default Story Aeneid
}

/**
 * Discovers every Story LicenseToken the agent holds by scanning ERC-721 Transfer events to/from the
 * agent wallet. The agent presents these ids when decrypting a CDR vault; the on-chain read condition
 * picks whichever is a valid license for that vault's IP. This is what makes multi-leader CDR work:
 * each leader mints one operator license to the agent, and the agent decrypts only their signals.
 */
export class LicenseDiscovery {
  private readonly client: PublicClient;
  private readonly owner: Hex;
  private readonly licenseToken: Hex;
  private readonly tokenIds = new Set<bigint>();

  constructor(cfg: LicenseDiscoveryConfig) {
    const chain = defineChain({
      id: cfg.chainId ?? STORY_AENEID.id,
      name: STORY_AENEID.name,
      nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
      rpcUrls: { default: { http: [cfg.storyRpcUrl] } },
    });
    this.client = createPublicClient({ chain, transport: http(cfg.storyRpcUrl) });
    this.owner = cfg.owner;
    this.licenseToken = (cfg.licenseToken ?? STORY_AENEID_ADDRESSES.licenseToken) as Hex;
    for (const id of cfg.seed ?? []) this.tokenIds.add(id);
  }

  /** Current known license token ids (held by the agent). */
  get(): bigint[] {
    return [...this.tokenIds];
  }

  /** Re-scan Transfer events; adds inbound tokens, drops any transferred away. Safe to call often. */
  async refresh(): Promise<bigint[]> {
    try {
      const inbound = await this.client.getContractEvents({
        address: this.licenseToken,
        abi: LICENSE_TOKEN_ABI,
        eventName: "Transfer",
        args: { to: this.owner },
        fromBlock: "earliest",
        toBlock: "latest",
      });
      for (const l of inbound) {
        const id = (l.args as { tokenId?: bigint }).tokenId;
        if (id !== undefined) this.tokenIds.add(id);
      }
      const outbound = await this.client.getContractEvents({
        address: this.licenseToken,
        abi: LICENSE_TOKEN_ABI,
        eventName: "Transfer",
        args: { from: this.owner },
        fromBlock: "earliest",
        toBlock: "latest",
      });
      for (const l of outbound) {
        const id = (l.args as { tokenId?: bigint }).tokenId;
        if (id !== undefined) this.tokenIds.delete(id);
      }
    } catch {
      // On a query failure keep the existing set (seed + whatever we already found).
    }
    return this.get();
  }
}
