import { loadConfig } from "./config.js";
import { Agent } from "./agent.js";
import { AgentLogger } from "./logger.js";
import { createSignalServer } from "./server.js";

/**
 * Daemon entrypoint (`pnpm --filter @sigmax/agent start`). Boots the agent, starts the TP/SL monitor,
 * serves the HTTP publish endpoint, optionally processes a signal uuid passed as argv[2] (the demo
 * trigger), and shuts down gracefully.
 */
async function main(): Promise<void> {
  const logger = new AgentLogger();
  const cfg = loadConfig();
  const agent = new Agent(cfg, logger);
  await agent.start();
  logger.info("agent_started");

  const server = createSignalServer(
    agent,
    { port: cfg.httpPort, allowOrigin: cfg.webOrigin },
    logger,
  );

  const uuidArg = process.argv[2];
  if (uuidArg !== undefined) {
    await agent.processSignal(Number(uuidArg));
  }

  const shutdown = async () => {
    logger.info("agent_stopping");
    server.close();
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
