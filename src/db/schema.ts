import {
  pgTable,
  serial,
  text,
  boolean,
  integer,
  timestamp,
  bigint,
  varchar,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ─── Conversations ─────────────────────────────────────────────────
// Every chat we've seen from chat.db — DMs, groups, SMS, iMessage
export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),
    chatGuid: text("chat_guid").notNull().unique(), // "iMessage;-;+1234567890" or "iMessage;+;chat123456"
    chatIdentifier: text("chat_identifier"), // "+1234567890" or "chat123456" (3rd segment of GUID)
    displayName: text("display_name"), // Group name or contact name
    service: varchar("service", { length: 20 }).notNull(), // "iMessage" or "SMS"
    isGroup: boolean("is_group").notNull().default(false),
    assignedAgentId: text("assigned_agent_id"), // "bobby", "bernard", "patti", null
    routingRuleId: integer("routing_rule_id"), // FK to routing_rules
    autoAssigned: boolean("auto_assigned").notNull().default(true), // Was this auto-assigned or manual?
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at"),
    lastMessagePreview: text("last_message_preview"), // Short preview for the UI
    messageCount: integer("message_count").notNull().default(0),
    metadata: jsonb("metadata"), // Flexible extra data
  },
  (table) => [
    uniqueIndex("conversations_chat_guid_idx").on(table.chatGuid),
    index("conversations_assigned_agent_idx").on(table.assignedAgentId),
    index("conversations_last_message_idx").on(table.lastMessageAt),
  ],
);

// ─── Routing Rules ─────────────────────────────────────────────────
// Priority-ordered rules for auto-assigning conversations to agents
export const routingRules = pgTable(
  "routing_rules",
  {
    id: serial("id").primaryKey(),
    priority: integer("priority").notNull().default(100), // Lower = higher priority
    name: text("name").notNull(), // Human-readable label
    description: text("description"),
    matchType: varchar("match_type", { length: 30 }).notNull(),
    // "exact_handle" — exact phone/email match
    // "handle_pattern" — wildcard/prefix match (+1860*)
    // "group_guid" — specific group chat GUID
    // "group_name" — match by group display name
    // "service" — match by service type (iMessage/SMS)
    // "is_group" — match all groups or all DMs
    // "default" — catch-all
    matchValue: text("match_value"), // The value to match against (null for "default")
    agentId: text("agent_id").notNull(), // Target agent
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("routing_rules_priority_idx").on(table.priority),
    index("routing_rules_enabled_idx").on(table.enabled),
  ],
);

// ─── Messages ──────────────────────────────────────────────────────
// Log of all messages seen (inbound + outbound) for history & dedup
export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    appleMessageId: bigint("apple_message_id", { mode: "number" }), // ROWID from chat.db
    appleGuid: text("apple_guid"), // Message GUID from chat.db
    conversationId: integer("conversation_id").notNull(), // FK to conversations
    senderHandle: text("sender_handle"), // Who sent it (null if from us)
    text: text("text"),
    isFromMe: boolean("is_from_me").notNull().default(false),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    attachmentCount: integer("attachment_count").notNull().default(0),
    agentId: text("agent_id"), // Which agent this was routed to/from
    deliveredToOpenclawAt: timestamp("delivered_to_openclaw_at"), // When we forwarded it
    deliveryStatus: varchar("delivery_status", { length: 20 }).default("pending"),
    // "pending" — seen in chat.db, not yet delivered
    // "delivered" — sent to OpenClaw agent
    // "failed" — delivery attempt failed
    // "skipped" — filtered out (e.g., duplicate, reaction)
    appleTimestamp: bigint("apple_timestamp", { mode: "bigint" }), // Raw Apple epoch nanoseconds
    associatedMessageType: integer("associated_message_type"), // 0=normal, 2000+=reaction
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("messages_apple_message_id_idx").on(table.appleMessageId),
    index("messages_conversation_id_idx").on(table.conversationId),
    index("messages_created_at_idx").on(table.createdAt),
    index("messages_delivery_status_idx").on(table.deliveryStatus),
  ],
);

// ─── Attachments ───────────────────────────────────────────────────
export const attachments = pgTable(
  "attachments",
  {
    id: serial("id").primaryKey(),
    messageId: integer("message_id").notNull(), // FK to messages
    appleAttachmentId: bigint("apple_attachment_id", { mode: "number" }),
    originalPath: text("original_path"), // Path in ~/Library/Messages/Attachments/
    convertedPath: text("converted_path"), // Path after HEIC conversion (if applicable)
    mimeType: text("mime_type"),
    originalMimeType: text("original_mime_type"), // Before conversion
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    conversionStatus: varchar("conversion_status", { length: 20 }).default("none"),
    // "none" — no conversion needed
    // "pending" — needs conversion
    // "converted" — successfully converted
    // "failed" — conversion failed
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("attachments_message_id_idx").on(table.messageId),
  ],
);

// ─── Chat Participants ─────────────────────────────────────────────
// Track who's in each group chat
export const chatParticipants = pgTable(
  "chat_participants",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id").notNull(), // FK to conversations
    handle: text("handle").notNull(), // Phone number or email
    displayName: text("display_name"), // Contact name if known
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_participants_conv_handle_idx").on(
      table.conversationId,
      table.handle,
    ),
    index("chat_participants_handle_idx").on(table.handle),
  ],
);

// ─── Poller State ──────────────────────────────────────────────────
// Track polling watermark so restarts don't miss/duplicate messages
export const pollerState = pgTable("poller_state", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 50 }).notNull().unique(), // "last_message_rowid", "last_message_date"
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Agent Cache ───────────────────────────────────────────────────
// Cached agent info from OpenClaw (refreshed periodically)
export const agentCache = pgTable("agent_cache", {
  id: serial("id").primaryKey(),
  agentId: text("agent_id").notNull().unique(),
  name: text("name"),
  emoji: text("emoji"),
  theme: text("theme"),
  isDefault: boolean("is_default").notNull().default(false),
  lastSyncedAt: timestamp("last_synced_at").notNull().defaultNow(),
});
