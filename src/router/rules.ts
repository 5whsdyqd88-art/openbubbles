/**
 * Routing rule evaluation engine.
 * Evaluates rules in priority order to determine which agent handles a conversation.
 */

import { eq, asc, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { routingRules, conversations } from "../db/schema.js";
import type { ProcessedMessage } from "../poller/watcher.js";

export interface RoutingDecision {
  agentId: string;
  ruleId: number | null;       // Which rule matched (null = manual assignment)
  ruleName: string | null;
  isDefault: boolean;           // Was the default/catch-all rule used?
  isNewConversation: boolean;
}

export interface RouterOptions {
  db: PostgresJsDatabase;
  /** Default agent when no rules match and no default rule exists */
  fallbackAgentId?: string;
  log?: (msg: string) => void;
}

export class Router {
  private db: PostgresJsDatabase;
  private fallbackAgentId: string;
  private log: (msg: string) => void;

  // Cache rules in memory, refresh periodically
  private rulesCache: RuleRecord[] = [];
  private lastRulesFetch = 0;
  private rulesCacheTtlMs = 5000; // Refresh every 5s

  constructor(options: RouterOptions) {
    this.db = options.db;
    this.fallbackAgentId = options.fallbackAgentId ?? "main";
    this.log = options.log ?? ((msg) => console.log(`[router] ${msg}`));
  }

  /**
   * Route a message to an agent.
   * 1. If conversation already has an agent assigned, use that.
   * 2. Otherwise, evaluate routing rules.
   * 3. Store the assignment in Postgres.
   */
  async route(message: ProcessedMessage): Promise<RoutingDecision> {
    // Check if conversation already has an agent
    const conv = await this.db
      .select({
        assignedAgentId: conversations.assignedAgentId,
        routingRuleId: conversations.routingRuleId,
      })
      .from(conversations)
      .where(eq(conversations.id, message.conversationId))
      .limit(1);

    if (conv.length > 0 && conv[0].assignedAgentId) {
      return {
        agentId: conv[0].assignedAgentId,
        ruleId: conv[0].routingRuleId,
        ruleName: null,
        isDefault: false,
        isNewConversation: false,
      };
    }

    // Evaluate rules
    const rules = await this.getRules();
    const decision = this.evaluateRules(rules, message);

    // Store assignment
    await this.db
      .update(conversations)
      .set({
        assignedAgentId: decision.agentId,
        routingRuleId: decision.ruleId,
        autoAssigned: true,
      })
      .where(eq(conversations.id, message.conversationId));

    this.log(
      `assigned ${message.parsed.chatGuid} → ${decision.agentId} (rule: ${decision.ruleName || "fallback"})`,
    );

    return decision;
  }

  /**
   * Manually assign a conversation to an agent.
   * Overrides any automatic assignment.
   */
  async assignConversation(
    conversationId: number,
    agentId: string,
  ): Promise<void> {
    await this.db
      .update(conversations)
      .set({
        assignedAgentId: agentId,
        routingRuleId: null,
        autoAssigned: false,
      })
      .where(eq(conversations.id, conversationId));
  }

  /**
   * Evaluate rules against a message, return the first match.
   */
  private evaluateRules(
    rules: RuleRecord[],
    message: ProcessedMessage,
  ): RoutingDecision {
    const msg = message.parsed;

    for (const rule of rules) {
      if (!rule.enabled) continue;

      let matched = false;

      switch (rule.matchType) {
        case "exact_handle":
          // Match exact phone number or email (DM only)
          matched =
            !msg.isGroup &&
            !!msg.senderHandle &&
            !!rule.matchValue &&
            normalizeHandle(msg.senderHandle) === normalizeHandle(rule.matchValue);
          break;

        case "handle_pattern":
          // Wildcard prefix match, e.g., "+1860*"
          if (rule.matchValue && msg.senderHandle) {
            const pattern = rule.matchValue.replace(/\*/g, "");
            matched =
              !msg.isGroup &&
              normalizeHandle(msg.senderHandle).startsWith(
                normalizeHandle(pattern),
              );
          }
          break;

        case "group_guid":
          // Match specific group by GUID
          matched =
            msg.isGroup &&
            !!rule.matchValue &&
            msg.chatGuid === rule.matchValue;
          break;

        case "group_name":
          // Match group by display name (case-insensitive)
          matched =
            msg.isGroup &&
            !!msg.displayName &&
            !!rule.matchValue &&
            msg.displayName.toLowerCase().includes(rule.matchValue.toLowerCase());
          break;

        case "service":
          // Match by service type (iMessage/SMS)
          matched =
            !!rule.matchValue &&
            msg.service.toLowerCase() === rule.matchValue.toLowerCase();
          break;

        case "is_group":
          // Match all groups or all DMs
          if (rule.matchValue === "true") matched = msg.isGroup;
          else if (rule.matchValue === "false") matched = !msg.isGroup;
          break;

        case "default":
          // Catch-all — always matches
          matched = true;
          break;
      }

      if (matched) {
        return {
          agentId: rule.agentId,
          ruleId: rule.id,
          ruleName: rule.name,
          isDefault: rule.matchType === "default",
          isNewConversation: message.isNewConversation,
        };
      }
    }

    // No rules matched — use fallback
    return {
      agentId: this.fallbackAgentId,
      ruleId: null,
      ruleName: null,
      isDefault: true,
      isNewConversation: message.isNewConversation,
    };
  }

  /**
   * Get rules from cache or database.
   */
  private async getRules(): Promise<RuleRecord[]> {
    const now = Date.now();
    if (now - this.lastRulesFetch < this.rulesCacheTtlMs && this.rulesCache.length > 0) {
      return this.rulesCache;
    }

    this.rulesCache = await this.db
      .select()
      .from(routingRules)
      .where(eq(routingRules.enabled, true))
      .orderBy(asc(routingRules.priority));

    this.lastRulesFetch = now;
    return this.rulesCache;
  }

  /** Force refresh the rules cache */
  invalidateCache(): void {
    this.lastRulesFetch = 0;
  }
}

type RuleRecord = typeof routingRules.$inferSelect;

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/[\s()-]/g, "").toLowerCase();
}
