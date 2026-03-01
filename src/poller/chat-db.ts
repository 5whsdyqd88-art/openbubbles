/**
 * Read Apple's chat.db (SQLite) for inbound messages.
 * Uses better-sqlite3 for synchronous, fast reads.
 *
 * IMPORTANT: chat.db is READ-ONLY. We never write to it.
 */

import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  type ChatDbMessageRow,
  type ChatDbChatRow,
  type ParsedMessage,
  type ParsedAttachment,
  appleNsToDate,
  isGroupFromGuid,
  serviceFromGuid,
  identifierFromGuid,
} from "./entities.js";

export interface ChatDbReaderOptions {
  /** Path to chat.db. Defaults to ~/Library/Messages/chat.db */
  dbPath?: string;
}

export class ChatDbReader {
  private db: Database.Database;
  private dbPath: string;

  constructor(options: ChatDbReaderOptions = {}) {
    this.dbPath =
      options.dbPath ||
      path.join(os.homedir(), "Library", "Messages", "chat.db");

    if (!fs.existsSync(this.dbPath)) {
      throw new Error(
        `chat.db not found at ${this.dbPath}. Ensure Messages.app is configured and Full Disk Access is granted.`,
      );
    }

    // Open read-only — we never write to Apple's database
    this.db = new Database(this.dbPath, { readonly: true });
    this.db.pragma("journal_mode = WAL");
  }

  /**
   * Get messages newer than a given ROWID.
   * This is the core polling query — called every ~2 seconds.
   *
   * NOTE: We do NOT filter on cache_roomnames (which would exclude group chats).
   * That was the interagents skill bug.
   */
  getMessagesSince(lastRowId: number, limit = 500): ParsedMessage[] {
    const query = `
      SELECT
        message.ROWID as message_id,
        message.text,
        message.date,
        message.is_from_me,
        handle.id as sender,
        chat.ROWID as chat_id,
        chat.guid as chat_guid,
        chat.chat_identifier,
        chat.display_name,
        chat.service_name,
        message.associated_message_type,
        attachment.ROWID as attachment_id,
        attachment.filename as attachment_filename,
        attachment.mime_type as attachment_mime_type,
        attachment.total_bytes as attachment_total_bytes
      FROM message
      LEFT JOIN handle ON message.handle_id = handle.ROWID
      LEFT JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
      LEFT JOIN chat ON chat_message_join.chat_id = chat.ROWID
      LEFT JOIN message_attachment_join ON message.ROWID = message_attachment_join.message_id
      LEFT JOIN attachment ON message_attachment_join.attachment_id = attachment.ROWID
      WHERE message.ROWID > ?
      ORDER BY message.ROWID ASC, attachment.ROWID ASC
      LIMIT ?
    `;

    const rows = this.db.prepare(query).all(lastRowId, limit) as ChatDbMessageRow[];
    return this.consolidateMessages(rows);
  }

  /**
   * Get the highest message ROWID in chat.db.
   * Used to initialize the polling watermark.
   */
  getMaxMessageRowId(): number {
    const row = this.db
      .prepare("SELECT MAX(ROWID) as max_id FROM message")
      .get() as { max_id: number | null };
    return row?.max_id ?? 0;
  }

  /**
   * List all chats (conversations) in chat.db.
   * Used for initial sync and the web UI.
   */
  listChats(): ChatDbChatRow[] {
    const query = `
      SELECT
        ROWID, guid, chat_identifier, display_name, service_name, style
      FROM chat
      ORDER BY ROWID DESC
    `;
    return this.db.prepare(query).all() as ChatDbChatRow[];
  }

  /**
   * Get participants for a chat (group members).
   */
  getChatParticipants(chatRowId: number): string[] {
    const query = `
      SELECT handle.id
      FROM chat_handle_join
      JOIN handle ON chat_handle_join.handle_id = handle.ROWID
      WHERE chat_handle_join.chat_id = ?
    `;
    const rows = this.db.prepare(query).all(chatRowId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * Get all participants for all chats (bulk query for initial sync).
   */
  getAllChatParticipants(): Map<number, string[]> {
    const query = `
      SELECT chat_handle_join.chat_id, handle.id
      FROM chat_handle_join
      JOIN handle ON chat_handle_join.handle_id = handle.ROWID
    `;
    const rows = this.db.prepare(query).all() as {
      chat_id: number;
      id: string;
    }[];

    const map = new Map<number, string[]>();
    for (const row of rows) {
      const existing = map.get(row.chat_id) ?? [];
      existing.push(row.id);
      map.set(row.chat_id, existing);
    }
    return map;
  }

  /**
   * Consolidate SQL rows into ParsedMessage objects.
   * Multiple rows can map to the same message (one per attachment).
   */
  private consolidateMessages(rows: ChatDbMessageRow[]): ParsedMessage[] {
    const byId = new Map<number, ParsedMessage>();

    for (const row of rows) {
      if (!row.message_id || !row.date) continue;
      // Skip reactions/tapbacks
      if (row.associated_message_type && row.associated_message_type !== 0) continue;
      // Skip messages with no chat (orphaned)
      if (!row.chat_guid) continue;

      const existing = byId.get(row.message_id);

      if (!existing) {
        const appleTimestamp = BigInt(row.date);
        const chatGuid = row.chat_guid;

        byId.set(row.message_id, {
          messageId: row.message_id,
          text: this.sanitizeText(row.text),
          senderHandle: row.sender?.trim() || null,
          isFromMe: row.is_from_me === 1,
          chatGuid,
          chatIdentifier: row.chat_identifier || identifierFromGuid(chatGuid),
          displayName: row.display_name?.trim() || null,
          service: row.service_name || serviceFromGuid(chatGuid),
          isGroup: isGroupFromGuid(chatGuid),
          appleTimestamp,
          createdAt: appleNsToDate(appleTimestamp),
          associatedMessageType: row.associated_message_type || 0,
          isReaction: false,
          attachments: [],
        });
      }

      // Add attachment if present
      const msg = byId.get(row.message_id)!;
      if (row.attachment_id && row.attachment_filename) {
        const normalizedPath = this.normalizeAttachmentPath(row.attachment_filename);
        if (normalizedPath) {
          // Avoid duplicate attachments (same attachment_id)
          const alreadyHas = msg.attachments.some(
            (a) => a.attachmentId === row.attachment_id,
          );
          if (!alreadyHas) {
            msg.attachments.push({
              attachmentId: row.attachment_id!,
              filename: path.basename(normalizedPath),
              mimeType: row.attachment_mime_type || null,
              totalBytes: row.attachment_total_bytes || null,
              normalizedPath,
            });
          }
        }
      }
    }

    return Array.from(byId.values());
  }

  /**
   * Clean up message text — remove object replacement characters (U+FFFC)
   * that Apple inserts as attachment placeholders.
   */
  private sanitizeText(text: string | null): string {
    if (!text) return "";
    return text.replace(/\uFFFC/g, "").trim();
  }

  /**
   * Normalize attachment paths — expand tildes, make relative paths absolute.
   */
  private normalizeAttachmentPath(rawPath: string | null): string {
    if (!rawPath) return "";
    let p = rawPath.trim();

    if (p.startsWith("file://")) p = p.slice(7);
    if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));

    // Relative paths are relative to ~/Library/Messages/Attachments
    if (!path.isAbsolute(p)) {
      if (
        p.startsWith("Library/") ||
        p.startsWith("Library\\")
      ) {
        p = path.join(os.homedir(), p);
      } else {
        p = path.join(
          os.homedir(),
          "Library",
          "Messages",
          "Attachments",
          p,
        );
      }
    }

    return p;
  }

  close(): void {
    this.db.close();
  }
}
