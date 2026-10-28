import { serve } from "@hono/node-server";
import { buildApiServices } from "../composition/index.js";
import { createConsoleLogger } from "../shared/index.js";
import { createApp, DEFAULT_ALLOWED_ORIGINS } from "./app.js";
import { API_USAGE, parseApiArgs } from "./args.js";

// Starts the HTTP API: `pnpm api`. An entry point beside `pnpm chat`; it builds the same pipeline
// from the same configuration and serves it.

const args = parseApiArgs(process.argv.slice(2));

if ("error" in args) {
  console.error(`${args.error}\n\n${API_USAGE}`);
  process.exitCode = 2;
} else {
  const logger = createConsoleLogger();
  try {
    const services = await buildApiServices({
      logger,
      ...(args.variant === undefined ? {} : { variant: args.variant }),
      ...(args.processedDir === undefined ? {} : { processedDir: args.processedDir }),
      ...(args.rawDir === undefined ? {} : { rawDir: args.rawDir }),
      ...(args.feedbackFile === undefined ? {} : { feedbackFile: args.feedbackFile }),
      ...(args.indexDir === undefined ? {} : { indexDir: args.indexDir }),
      ...(args.cacheDir === undefined ? {} : { cacheDir: args.cacheDir }),
    });
    const app = createApp(services, {
      allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS, ...args.origins],
      logger,
    });

    const server = serve({ fetch: app.fetch, port: args.port, hostname: args.host }, (info) => {
      logger.info("listening", {
        url: `http://${info.address}:${info.port.toString()}`,
        index: services.namespace,
        model: services.model,
        feedback: services.feedback.location,
      });
    });
    // Ctrl+C: stop taking requests and let the one in progress end
    process.once("SIGINT", () => {
      server.close();
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
