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
import { type CdrPort, ReadConditionDenied } from "./port.js";

export interface RealCdrConfig {
  privateKey: Hex; // CDR access key — funded Aeneid wallet; holds the operator license
  rpcUrl?: string; // Story RPC (default Aeneid public)
  apiUrl: string; // Story-API REST base (DKG partials endpoint)
  network?: "mainnet" | "testnet"; // cdr-contracts Network — Aeneid IS "testnet" (NOT "aeneid")
  ipId: Hex; // strategy IP Asset (ERC-6551 address)
  leader: Hex; // owner allowed to write (OwnerWriteCondition)
  operatorLicenseTokenId: bigint; // license token id the agent holds for ipId
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

  constructor(cfg: RealCdrConfig) {
    this.cfg = cfg;
    const account = privateKeyToAccount(cfg.privateKey);
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

  async publishSignal(signal: Signal): Promise<{ uuid: number }> {
    await initWasm();
    const readConditionData = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }],
      [STORY_AENEID_ADDRESSES.licenseToken as Hex, this.cfg.ipId],
    );
    const writeConditionData = encodeAbiParameters([{ type: "address" }], [this.cfg.leader]);
    const { uuid } = await this.client.uploader.uploadCDR({
      dataKey: hexToBytes(encodeSignal(signal)),
      updatable: false, // fresh vault per signal → independently auditable (doc 20 §4)
      writeConditionAddr: STORY_AENEID_ADDRESSES.ownerWriteCondition as Hex,
      readConditionAddr: STORY_AENEID_ADDRESSES.licenseReadCondition as Hex,
      writeConditionData,
      readConditionData,
      accessAuxData: "0x",
    });
    return { uuid };
  }

  async accessSignal(uuid: number): Promise<Signal> {
    await initWasm();
    const accessAuxData = encodeAbiParameters(
      [{ type: "uint256[]" }],
      [[this.cfg.operatorLicenseTokenId]],
    );
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
