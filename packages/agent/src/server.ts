import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { SignalSchema, type Signal } from "@sigmax/shared";
import type { Agent } from "./agent.js";
import { AgentLogger } from "./logger.js";

export interface SignalServerOptions {
  port: number;
  allowOrigin: string;
}

/**
 * Minimal HTTP surface for the leader UI to publish signals. CDR encryption is server-only (it needs
 * the CDR key, Node-only deps, and WASM), so the browser POSTs the plaintext Signal here over a
 * trusted channel and the agent encrypts it via RealCdr. The request body carries TP/SL and is NEVER
 * logged — only the resulting uuid + non-secret identifiers (CLAUDE.md rule 3). For demo smoothness
 * the agent also processes the signal immediately (fire-and-forget) so the swap fans out.
 */
export function createSignalServer(
  agent: Agent,
  opts: SignalServerOptions,
  logger = new AgentLogger(),
): Server {
  const server = createServer((req, res) => void handle(req, res, agent, opts, logger));
  server.listen(opts.port, () => logger.info("http_listening", { port: String(opts.port) }));
  return server;
}

/**
 * `allowOrigin` is a comma-separated allowlist. Browsers require the `access-control-allow-origin`
 * header to exactly match the request's Origin, so we echo the incoming Origin when it's allowed
 * (and fall back to the first configured origin otherwise). `Vary: Origin` keeps caches correct.
 */
function setCors(res: ServerResponse, allowOrigin: string, reqOrigin?: string): void {
  const allowed = allowOrigin
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const origin = reqOrigin && allowed.includes(reqOrigin) ? reqOrigin : (allowed[0] ?? "");
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, x-leader-address");
}

async function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  agent: Agent,
  opts: SignalServerOptions,
  logger: AgentLogger,
): Promise<void> {
  setCors(res, opts.allowOrigin, req.headers.origin);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url === "/signals/publish") {
    let signal: Signal;
    try {
      const raw = await readBody(req);
      // Validate but NEVER log the parsed body (it carries TP/SL). On failure log the event only.
      signal = SignalSchema.parse(JSON.parse(raw));
    } catch {
      logger.info("publish_bad_request");
      json(res, 400, { error: "invalid signal" });
      return;
    }

    try {
      const { uuid } = await agent.publishSignal(signal);
      logger.signalReceived({
        uuid,
        strategyId: signal.strategyId,
        signalId: signal.signalId,
        action: signal.action,
      });
      json(res, 200, { uuid });
      // Demo convenience: process immediately so the swap fans out. Fire-and-forget.
      void agent.processSignal(uuid).catch((err) =>
        logger.error({
          event: "auto_process_failed",
          message: err instanceof Error ? err.message : String(err),
          signalId: signal.signalId,
        }),
      );
    } catch (err) {
      logger.error({
        event: "publish_failed",
        message: err instanceof Error ? err.message : String(err),
        signalId: signal.signalId,
      });
      json(res, 500, { error: "publish failed" });
    }
    return;
  }

  json(res, 404, { error: "not found" });
}
