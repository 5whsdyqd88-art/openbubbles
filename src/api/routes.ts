/**
 * REST API for the web GUI and external integrations.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { eq, desc, asc, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  conversations,
  routingRules,
  messages,
  chatParticipants,
  agentCache,
} from "../db/schema.js";
import type { Router } from "../router/rules.js";
import type { OpenClawClient } from "../openclaw/client.js";

export interface ApiOptions {
  db: PostgresJsDatabase;
  router: Router;
  openclawClient: OpenClawClient;
}

export function createApi(options: ApiOptions): Hono {
  const { db, router, openclawClient } = options;
  const app = new Hono();

  app.use("/*", cors());

  // ─── Health ────────────────────────────────────────────────────
  app.get("/api/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

  // ─── Conversations ─────────────────────────────────────────────
  app.get("/api/conversations", async (c) => {
    const rows = await db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.lastMessageAt))
      .limit(200);
    return c.json({ conversations: rows });
  });

  app.get("/api/conversations/:id", async (c) => {
    const id = parseInt(c.req.param("id"));
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    if (!conv) return c.json({ error: "not found" }, 404);

    const participants = await db
      .select()
      .from(chatParticipants)
      .where(eq(chatParticipants.conversationId, id));

    const recentMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(desc(messages.createdAt))
      .limit(50);

    return c.json({ conversation: conv, participants, messages: recentMessages });
  });

  app.put("/api/conversations/:id/assign", async (c) => {
    const id = parseInt(c.req.param("id"));
    const body = await c.req.json<{ agentId: string }>();
    if (!body.agentId) return c.json({ error: "agentId required" }, 400);

    await router.assignConversation(id, body.agentId);
    return c.json({ success: true });
  });

  // ─── Routing Rules ─────────────────────────────────────────────
  app.get("/api/rules", async (c) => {
    const rows = await db
      .select()
      .from(routingRules)
      .orderBy(asc(routingRules.priority));
    return c.json({ rules: rows });
  });

  app.post("/api/rules", async (c) => {
    const body = await c.req.json<{
      name: string;
      matchType: string;
      matchValue?: string;
      agentId: string;
      priority?: number;
      description?: string;
    }>();

    if (!body.name || !body.matchType || !body.agentId) {
      return c.json({ error: "name, matchType, and agentId are required" }, 400);
    }

    const [created] = await db
      .insert(routingRules)
      .values({
        name: body.name,
        matchType: body.matchType,
        matchValue: body.matchValue ?? null,
        agentId: body.agentId,
        priority: body.priority ?? 100,
        description: body.description ?? null,
      })
      .returning();

    router.invalidateCache();
    return c.json({ rule: created }, 201);
  });

  app.put("/api/rules/:id", async (c) => {
    const id = parseInt(c.req.param("id"));
    const body = await c.req.json<Partial<{
      name: string;
      matchType: string;
      matchValue: string;
      agentId: string;
      priority: number;
      description: string;
      enabled: boolean;
    }>>();

    await db
      .update(routingRules)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(routingRules.id, id));

    router.invalidateCache();
    return c.json({ success: true });
  });

  app.delete("/api/rules/:id", async (c) => {
    const id = parseInt(c.req.param("id"));
    await db.delete(routingRules).where(eq(routingRules.id, id));
    router.invalidateCache();
    return c.json({ success: true });
  });

  // ─── Agents (from OpenClaw) ────────────────────────────────────
  app.get("/api/agents", async (c) => {
    // Try live fetch from OpenClaw, fall back to cache
    const liveAgents = await openclawClient.listAgents();
    if (liveAgents.length > 0) {
      // Update cache
      for (const agent of liveAgents) {
        await db
          .insert(agentCache)
          .values({
            agentId: agent.id,
            name: agent.name,
            emoji: agent.emoji,
            lastSyncedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: agentCache.agentId,
            set: {
              name: agent.name,
              emoji: agent.emoji,
              lastSyncedAt: new Date(),
            },
          });
      }
      return c.json({ agents: liveAgents, source: "live" });
    }

    // Fall back to cache
    const cached = await db.select().from(agentCache);
    return c.json({
      agents: cached.map((a) => ({
        id: a.agentId,
        name: a.name,
        emoji: a.emoji,
      })),
      source: "cache",
    });
  });

  // ─── Stats ─────────────────────────────────────────────────────
  app.get("/api/stats", async (c) => {
    const [convCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(conversations);
    const [msgCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages);
    const [unrouted] = await db
      .select({ count: sql<number>`count(*)` })
      .from(conversations)
      .where(sql`${conversations.assignedAgentId} IS NULL`);

    return c.json({
      totalConversations: convCount.count,
      totalMessages: msgCount.count,
      unroutedConversations: unrouted.count,
    });
  });

  // ─── Outbound send (called by OpenClaw agents) ────────────────
  app.post("/api/send", async (c) => {
    const body = await c.req.json<{
      chatGuid: string;
      text?: string;
      filePath?: string;
      agentId?: string;
    }>();

    if (!body.chatGuid) {
      return c.json({ error: "chatGuid is required" }, 400);
    }

    // Dynamic import to avoid circular deps
    const { sendMessage } = await import("../sender/applescript.js");
    const result = await sendMessage({
      chatGuid: body.chatGuid,
      text: body.text,
      filePath: body.filePath,
    });

    return c.json(result);
  });

  return app;
}
