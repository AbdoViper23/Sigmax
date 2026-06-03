import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  encodeAbiParameters,
  hexToBytes,
  bytesToHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";
import {
  encodeSignal,
  decodeSignal,
  STORY_AENEID,
  STORY_AENEID_ADDRESSES,
  type Signal,
} from "@sigmax/shared";
import { type CdrPort, type CdrPublishTxHashes, ReadConditionDenied } from "./port.js";

export interface RealCdrConfig {
  privateKey: Hex; // CDR access key — funded Aeneid wallet; writes vaults + holds the operator licenses
  rpcUrl?: string; // Story RPC (default Aeneid public)
  apiUrl: string; // Story-API REST base (DKG partials endpoint)
  network?: "mainnet" | "testnet"; // cdr-contracts Network — Aeneid IS "testnet" (NOT "aeneid")
  /**
   * MULTI-LEADER: a vault is read-gated to (licenseToken, ipId) where ipId = signal.strategyId. The
   * agent satisfies the gate by presenting the license token id(s) it holds; passing ALL of them lets
   * the on-chain condition match the right one for whichever IP the vault belongs to — so the agent
   * never needs to know a vault's IP up front. Supplied as a callback so the set can refresh as new
   * leaders mint licenses to the agent.
   */
  getLicenseTokenIds: () => bigint[];
}

const storyChain = defineChain({
  id: STORY_AENEID.id,
  name: STORY_AENEID.name,
  nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
  rpcUrls: { default: { http: [STORY_AENEID.rpcUrl] } },
});

/** Wraps @piplabs/cdr-sdk 0.2.1 for the data-key vault path (uploadCDR/accessCDR). */
export class RealCdr implements CdrPort {
  private readonly client: CDRClient;
  private readonly cfg: RealCdrConfig;
  private readonly ownerAddress: Hex; // the agent's CDR wallet — the vault writer (OwnerWriteCondition)

  constructor(cfg: RealCdrConfig) {
    this.cfg = cfg;
    const account = privateKeyToAccount(cfg.privateKey);
    this.ownerAddress = account.address;
    const transport = http(cfg.rpcUrl ?? STORY_AENEID.rpcUrl);
    const publicClient = createPublicClient({ chain: storyChain, transport });
    const walletClient = createWalletClient({ account, chain: storyChain, transport });
    this.client = new CDRClient({
      // cdr-contracts Network id; "aeneid" expected — surfaced on first live run.
      network: cfg.network ?? "testnet",
      publicClient,
      walletClient,
      apiUrl: cfg.apiUrl,
    });
  }

  async publishSignal(signal: Signal): Promise<{ uuid: number; txHashes: CdrPublishTxHashes }> {
    await initWasm();
    // Read-gate this vault to the signal's own leader IP, so only an agent holding a license for THAT
    // IP can decrypt it (per-leader confidentiality). The agent's wallet is the writer (owner).
    const readConditionData = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }],
      [STORY_AENEID_ADDRESSES.licenseToken as Hex, signal.strategyId as Hex],
    );
    const writeConditionData = encodeAbiParameters([{ type: "address" }], [this.ownerAddress]);
    const { uuid, txHashes } = await this.client.uploader.uploadCDR({
      dataKey: hexToBytes(encodeSignal(signal)),
      updatable: false, // fresh vault per signal → independently auditable (doc 20 §4)
      writeConditionAddr: STORY_AENEID_ADDRESSES.ownerWriteCondition as Hex,
      readConditionAddr: STORY_AENEID_ADDRESSES.licenseReadCondition as Hex,
      writeConditionData,
      readConditionData,
      accessAuxData: "0x",
    });
    // Both are public on-chain ids (the encrypted signal body stays unlogged): `write` commits the
    // ciphertext (the commit-before-outcome proof), `allocate` creates the vault.
    return { uuid, txHashes: { allocate: txHashes.allocate, write: txHashes.write } };
  }

  async accessSignal(uuid: number): Promise<Signal> {
    await initWasm();
    // Present ALL license tokens the agent holds; the read condition matches whichever one is a valid
    // license for this vault's IP. No need to know the vault's IP up front (avoids a decrypt chicken/egg).
    const tokenIds = this.cfg.getLicenseTokenIds();
    const accessAuxData = encodeAbiParameters([{ type: "uint256[]" }], [tokenIds]);
    try {
      const { dataKey } = await this.client.consumer.accessCDR({
        uuid,
        accessAuxData,
        timeoutMs: 120_000,
      });
      return decodeSignal(bytesToHex(dataKey));
    } catch (err) {
      const msg = String(err);
      if (/condition|revert|unauthor|license/i.test(msg)) throw new ReadConditionDenied(msg);
      throw err;
    }
  }
}
