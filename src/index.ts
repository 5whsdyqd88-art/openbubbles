/**
 * openclaw-imessage-bridge — Main entry point.
 *
 * Starts:
 * 1. Postgres connection + schema migration
 * 2. chat.db poller (watches for new messages)
 * 3. Router (assigns conversations to agents)
 * 4. HTTP API + Web GUI (Hono)
 * 5. OpenClaw client (discovers agents, delivers messages)
 */

import { serve } from "@hono/node-server";
import { getDb, closeDb } from "./db/connection.js";
import { Watcher, type ProcessedMessage } from "./poller/watcher.js";
import { Router } from "./router/rules.js";
import { OpenClawClient } from "./openclaw/client.js";
import { createApi } from "./api/routes.js";
import { processInboundAttachments } from "./attachments/inbound.js";
import { eq } from "drizzle-orm";
import { messages } from "./db/schema.js";

const PORT = parseInt(process.env.BRIDGE_PORT ?? "3847", 10);
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:59679";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
const CHAT_DB_PATH = process.env.CHAT_DB_PATH; // undefined = default
const DEFAULT_AGENT = process.env.DEFAULT_AGENT ?? "bobby";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "2000", 10);

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  log("openclaw-imessage-bridge starting...");

  // 1. Connect to Postgres
  const db = getDb();
  log("connected to Postgres");

  // 2. Initialize OpenClaw client
  const openclawClient = new OpenClawClient({
    gatewayUrl: GATEWAY_URL,
    apiToken: GATEWAY_TOKEN || undefined,
    log,
  });

  const gatewayUp = await openclawClient.ping();
  log(`OpenClaw gateway: ${gatewayUp ? "reachable" : "NOT reachable"} at ${GATEWAY_URL}`);

  if (gatewayUp) {
    const agents = await openclawClient.listAgents();
    log(`discovered ${agents.length} agent(s): ${agents.map((a) => a.id).join(", ") || "none"}`);
  }

  // 3. Initialize router
  const router = new Router({
    db,
    fallbackAgentId: DEFAULT_AGENT,
    log,
  });

  // 4. Start chat.db poller
  const watcher = new Watcher({
    db,
    chatDbPath: CHAT_DB_PATH,
    pollIntervalMs: POLL_INTERVAL_MS,
    log,
    onError: (err) => log(`[error] ${err.message}`),
    onMessages: async (processed: ProcessedMessage[]) => {
      for (const msg of processed) {
        try {
          // Route the message to an agent
          const decision = await router.route(msg);

          // Process attachments: copy from Apple's storage, convert HEIC
          let mediaPaths: string[] = [];
          let mediaTypes: string[] = [];
          if (msg.parsed.attachments.length > 0) {
            const attachments = await processInboundAttachments(db, msg.id, log);
            mediaPaths = attachments.map((a) => a.localPath);
            mediaTypes = attachments.map((a) => a.mimeType);
            log(
              `processed ${attachments.length} attachment(s) for message ${msg.id}`,
            );
          }

          // Build sender label
          const senderLabel = msg.parsed.senderHandle || "unknown";
          const chatLabel = msg.parsed.isGroup
            ? msg.parsed.displayName || msg.parsed.chatIdentifier
            : senderLabel;
          const serviceFlag =
            msg.parsed.service === "iMessage"
              ? "🔵"
              : msg.parsed.service === "SMS"
                ? "🟢"
                : msg.parsed.service === "RCS"
                  ? "🟣"
                  : "⚪";

          // Deliver to OpenClaw
          const delivered = await openclawClient.deliverMessage({
            agentId: decision.agentId,
            from: senderLabel,
            to: `imessage-bridge:${msg.parsed.chatGuid}`,
            text: msg.parsed.text,
            chatType: msg.parsed.isGroup ? "group" : "direct",
            isGroup: msg.parsed.isGroup,
            groupName: msg.parsed.displayName ?? undefined,
            senderName: senderLabel,
            mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
            mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
            timestamp: Number(msg.parsed.appleTimestamp),
          });

          // Update delivery status
          await db
            .update(messages)
            .set({
              agentId: decision.agentId,
              deliveryStatus: delivered ? "delivered" : "failed",
              deliveredToOpenclawAt: delivered ? new Date() : null,
            })
            .where(eq(messages.id, msg.id));

          log(
            `${serviceFlag} ${msg.parsed.isGroup ? "group" : "dm"} from ${senderLabel} in ${chatLabel} → ${decision.agentId} (${delivered ? "✓" : "✗"})`,
          );
        } catch (err) {
          log(
            `[error] routing failed for message ${msg.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },
  });

  await watcher.start();

  // 5. Start HTTP API + Web GUI
  const api = createApi({ db, router, openclawClient });

  // Serve static media files
  // TODO: Add static file serving for /media/ → INBOUND_DIR

  serve(
    {
      fetch: api.fetch,
      port: PORT,
    },
    () => {
      log(`HTTP API listening on http://localhost:${PORT}`);
      log(`Web GUI: http://localhost:${PORT}`);
      log("─────────────────────────────────────");
      log(`Default agent: ${DEFAULT_AGENT}`);
      log(`Poll interval: ${POLL_INTERVAL_MS}ms`);
      log(`Service indicators: 🔵 iMessage  🟢 SMS  🟣 RCS`);
      log("─────────────────────────────────────");
      log("Bridge is running. Press Ctrl+C to stop.");
    },
  );

  // Graceful shutdown
  const shutdown = async () => {
    log("shutting down...");
    watcher.stop();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
