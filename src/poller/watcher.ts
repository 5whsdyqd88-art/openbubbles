/**
 * Poll loop: watch chat.db for new messages, process them through the router,
 * and track state in Postgres.
 */

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  conversations,
  messages,
  attachments as attachmentsTable,
  chatParticipants,
  pollerState,
} from "../db/schema.js";
import { ChatDbReader } from "./chat-db.js";
import type { ParsedMessage } from "./entities.js";

export interface WatcherOptions {
  /** Postgres database instance (Drizzle) */
  db: PostgresJsDatabase;
  /** Path to chat.db (optional, defaults to ~/Library/Messages/chat.db) */
  chatDbPath?: string;
  /** Polling interval in milliseconds (default: 2000) */
  pollIntervalMs?: number;
  /** Callback when new messages are ready for routing */
  onMessages?: (messages: ProcessedMessage[]) => Promise<void>;
  /** Callback for errors */
  onError?: (error: Error) => void;
  /** Logger */
  log?: (msg: string) => void;
}

export interface ProcessedMessage {
  /** Our Postgres message ID */
  id: number;
  /** The parsed message from chat.db */
  parsed: ParsedMessage;
  /** The conversation record from Postgres */
  conversationId: number;
  /** Whether this is a new conversation (first message we've seen) */
  isNewConversation: boolean;
}

export class Watcher {
  private reader: ChatDbReader;
  private db: PostgresJsDatabase;
  private pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRowId = 0;
  private onMessages: (messages: ProcessedMessage[]) => Promise<void>;
  private onError: (error: Error) => void;
  private log: (msg: string) => void;

  constructor(options: WatcherOptions) {
    this.reader = new ChatDbReader({ dbPath: options.chatDbPath });
    this.db = options.db;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.onMessages = options.onMessages ?? (async () => {});
    this.onError = options.onError ?? ((e) => console.error("[watcher]", e));
    this.log = options.log ?? ((msg) => console.log(`[watcher] ${msg}`));
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Restore last ROWID from Postgres (or initialize from chat.db)
    this.lastRowId = await this.restoreWatermark();
    this.log(`starting poll loop from ROWID ${this.lastRowId}`);

    // Sync existing chats on startup
    await this.syncExistingChats();

    this.schedulePoll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.reader.close();
    this.log("stopped");
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (err) {
        this.onError(err instanceof Error ? err : new Error(String(err)));
      }
      this.schedulePoll();
    }, this.pollIntervalMs);
  }

  private async pollOnce(): Promise<void> {
    const parsed = this.reader.getMessagesSince(this.lastRowId);
    if (parsed.length === 0) return;

    const processed: ProcessedMessage[] = [];

    for (const msg of parsed) {
      // Ensure conversation exists in Postgres
      const { conversationId, isNew } = await this.ensureConversation(msg);

      // Insert message record
      const [inserted] = await this.db
        .insert(messages)
        .values({
          appleMessageId: msg.messageId,
          conversationId,
          senderHandle: msg.senderHandle,
          text: msg.text || null,
          isFromMe: msg.isFromMe,
          hasAttachments: msg.attachments.length > 0,
          attachmentCount: msg.attachments.length,
          appleTimestamp: msg.appleTimestamp,
          associatedMessageType: msg.associatedMessageType,
          deliveryStatus: msg.isFromMe ? "skipped" : "pending",
        })
        .onConflictDoNothing({ target: messages.appleMessageId })
        .returning({ id: messages.id });

      if (!inserted) continue; // Duplicate, already processed

      // Insert attachments
      for (const att of msg.attachments) {
        const needsConversion =
          att.mimeType?.toLowerCase().includes("heic") ||
          att.normalizedPath.toLowerCase().endsWith(".heic");

        await this.db.insert(attachmentsTable).values({
          messageId: inserted.id,
          appleAttachmentId: att.attachmentId,
          originalPath: att.normalizedPath,
          mimeType: att.mimeType,
          originalMimeType: att.mimeType,
          sizeBytes: att.totalBytes,
          conversionStatus: needsConversion ? "pending" : "none",
        });
      }

      // Update conversation last message
      const preview = (msg.text || "").slice(0, 100) || (msg.attachments.length > 0 ? "<attachment>" : "");
      await this.db
        .update(conversations)
        .set({
          lastMessageAt: msg.createdAt,
          lastMessagePreview: preview,
          messageCount: conversations.messageCount, // TODO: increment
        })
        .where(eq(conversations.id, conversationId));

      // Only route inbound messages (not from us)
      if (!msg.isFromMe) {
        processed.push({
          id: inserted.id,
          parsed: msg,
          conversationId,
          isNewConversation: isNew,
        });
      }

      // Advance watermark
      if (msg.messageId > this.lastRowId) {
        this.lastRowId = msg.messageId;
      }
    }

    // Save watermark to Postgres
    await this.saveWatermark(this.lastRowId);

    // Deliver to router
    if (processed.length > 0) {
      this.log(`${processed.length} new inbound message(s)`);
      await this.onMessages(processed);
    }
  }

  /**
   * Ensure a conversation record exists in Postgres for this chat GUID.
   * Returns the conversation ID and whether it was just created.
   */
  private async ensureConversation(
    msg: ParsedMessage,
  ): Promise<{ conversationId: number; isNew: boolean }> {
    // Try to find existing
    const existing = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.chatGuid, msg.chatGuid))
      .limit(1);

    if (existing.length > 0) {
      return { conversationId: existing[0].id, isNew: false };
    }

    // Create new conversation
    const [created] = await this.db
      .insert(conversations)
      .values({
        chatGuid: msg.chatGuid,
        chatIdentifier: msg.chatIdentifier,
        displayName: msg.displayName,
        service: msg.service,
        isGroup: msg.isGroup,
        firstSeenAt: msg.createdAt,
        lastMessageAt: msg.createdAt,
      })
      .onConflictDoNothing({ target: conversations.chatGuid })
      .returning({ id: conversations.id });

    if (created) {
      this.log(
        `new conversation: ${msg.chatGuid} (${msg.isGroup ? "group" : "DM"}: ${msg.displayName || msg.chatIdentifier})`,
      );

      // Sync participants for group chats
      if (msg.isGroup) {
        await this.syncChatParticipants(created.id, msg.chatGuid);
      }

      return { conversationId: created.id, isNew: true };
    }

    // Race condition: another poll inserted it. Fetch again.
    const refetch = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.chatGuid, msg.chatGuid))
      .limit(1);

    return { conversationId: refetch[0].id, isNew: false };
  }

  /**
   * Sync group chat participants from chat.db → Postgres.
   */
  private async syncChatParticipants(
    conversationId: number,
    chatGuid: string,
  ): Promise<void> {
    // Find the chat ROWID from chat.db
    const chats = this.reader.listChats();
    const chat = chats.find((c) => c.guid === chatGuid);
    if (!chat) return;

    const participants = this.reader.getChatParticipants(chat.ROWID);
    for (const handle of participants) {
      await this.db
        .insert(chatParticipants)
        .values({
          conversationId,
          handle,
        })
        .onConflictDoNothing();
    }
  }

  /**
   * On startup, sync all existing chats from chat.db into Postgres.
   * This gives the web UI a full list of conversations to display.
   */
  private async syncExistingChats(): Promise<void> {
    const chats = this.reader.listChats();
    const allParticipants = this.reader.getAllChatParticipants();
    let newCount = 0;

    for (const chat of chats) {
      const isGroup = chat.guid.includes(";+;");
      const [created] = await this.db
        .insert(conversations)
        .values({
          chatGuid: chat.guid,
          chatIdentifier: chat.chat_identifier,
          displayName: chat.display_name?.trim() || null,
          service: chat.service_name || serviceFromGuid(chat.guid),
          isGroup,
        })
        .onConflictDoNothing({ target: conversations.chatGuid })
        .returning({ id: conversations.id });

      if (created && isGroup) {
        newCount++;
        const participants = allParticipants.get(chat.ROWID) ?? [];
        for (const handle of participants) {
          await this.db
            .insert(chatParticipants)
            .values({ conversationId: created.id, handle })
            .onConflictDoNothing();
        }
      }
    }

    this.log(`synced ${chats.length} chats (${newCount} new groups with participants)`);
  }

  /**
   * Restore polling watermark from Postgres.
   * If no watermark exists, start from current max ROWID (skip old messages).
   */
  private async restoreWatermark(): Promise<number> {
    const rows = await this.db
      .select({ value: pollerState.value })
      .from(pollerState)
      .where(eq(pollerState.key, "last_message_rowid"))
      .limit(1);

    if (rows.length > 0) {
      const saved = parseInt(rows[0].value, 10);
      if (!isNaN(saved) && saved > 0) {
        this.log(`restored watermark: ROWID ${saved}`);
        return saved;
      }
    }

    // First run — start from current max to avoid processing entire history
    const maxId = this.reader.getMaxMessageRowId();
    this.log(`first run, initializing watermark at ROWID ${maxId}`);
    await this.saveWatermark(maxId);
    return maxId;
  }

  private async saveWatermark(rowId: number): Promise<void> {
    await this.db
      .insert(pollerState)
      .values({ key: "last_message_rowid", value: String(rowId) })
      .onConflictDoUpdate({
        target: pollerState.key,
        set: { value: String(rowId), updatedAt: new Date() },
      });
  }
}

// Re-export for convenience
function serviceFromGuid(guid: string): string {
  if (guid.toLowerCase().startsWith("imessage;")) return "iMessage";
  if (guid.toLowerCase().startsWith("sms;")) return "SMS";
  return "unknown";
}
