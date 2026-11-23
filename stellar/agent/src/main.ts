/**
 * Sigmax agent: relay HTTP API plus relayer.
 *
 * Environment:
 *   RELAYER_SECRET       S... secret of the account that submits swaps and pays fees (required)
 *   SIGMAX_DEPLOYMENT    path to the deployment file (default ../deployments/testnet.json)
 *   ENCLAVE_URL          enclave service (default http://127.0.0.1:8787)
 *   AGENT_HOST/PORT      listen address (default 127.0.0.1:8788)
 *   CORS_ORIGIN          allowed browser origin (default *)
 *
 * API:
 *   GET  /health               relayer, enclave mode and keys, contract addresses
 *   POST /signals              { commitment, ciphertext } -> 202 job
 *   GET  /signals              recent jobs
 *   GET  /signals/:commitment  one job with per-vault results
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";

import { Chain, keypairSigner, parseDeployment } from "@sigmax/stellar-client";
import { Keypair } from "@stellar/stellar-sdk";

import { EnclaveClient } from "./enclave.js";
import { Relay } from "./relay.js";

const MAX_BODY = 32 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", fail);
  });
}

function main(): void {
  const secret = process.env.RELAYER_SECRET;
  if (!secret) {
    console.error("RELAYER_SECRET is required (an S... secret key; Testnet only)");
    process.exit(1);
  }
  const relayerKey = Keypair.fromSecret(secret);
  const deploymentPath = resolve(process.env.SIGMAX_DEPLOYMENT ?? "../deployments/testnet.json");
  const deployment = parseDeployment(JSON.parse(readFileSync(deploymentPath, "utf-8")));
  const chain = new Chain(deployment);
  const enclave = new EnclaveClient(process.env.ENCLAVE_URL ?? "http://127.0.0.1:8787");
  const relay = new Relay(chain, enclave, { publicKey: relayerKey.publicKey(), signer: keypairSigner(relayerKey) });
  const cors = process.env.CORS_ORIGIN ?? "*";

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": cors,
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS") return send(res, 204, {});
      if (req.method === "GET" && url.pathname === "/health") {
        const keys = await enclave.keys().catch((e: unknown) => ({ error: String(e) }));
        return send(res, 200, { ok: true, relayer: relayerKey.publicKey(), enclave: keys, contracts: deployment.contracts });
      }
      if (req.method === "POST" && url.pathname === "/signals") {
        const body = JSON.parse(await readBody(req)) as { commitment?: string; ciphertext?: string };
        if (!body.commitment || !body.ciphertext) return send(res, 400, { error: "commitment and ciphertext are required" });
        return send(res, 202, relay.accept(body.commitment, body.ciphertext));
      }
      if (req.method === "GET" && url.pathname === "/signals") return send(res, 200, relay.list());
      const m = /^\/signals\/([0-9a-fA-F]{64})$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const job = relay.get(m[1]!);
        return job ? send(res, 200, job) : send(res, 404, { error: "unknown signal" });
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  const host = process.env.AGENT_HOST ?? "127.0.0.1";
  const port = Number(process.env.AGENT_PORT ?? 8788);
  server.listen(port, host, () => {
    console.log(`sigmax agent on http://${host}:${port}; relayer ${relayerKey.publicKey()}; factory ${deployment.contracts.vaultFactory}`);
  });
}

main();
