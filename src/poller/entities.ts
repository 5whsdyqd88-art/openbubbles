/**
 * Types matching Apple's chat.db SQLite schema.
 * Reference: BlueBubbles server entity models + direct schema inspection.
 */

/** Apple epoch: 2001-01-01 00:00:00 UTC in Unix milliseconds */
export const APPLE_EPOCH_OFFSET_MS = 978307200000n;
export const NS_PER_MS = 1_000_000n;
export const NS_PER_S = 1_000_000_000n;

export function appleNsToUnixMs(appleNs: bigint): bigint {
  return appleNs / NS_PER_MS + APPLE_EPOCH_OFFSET_MS;
}

export function appleNsToDate(appleNs: bigint): Date {
  return new Date(Number(appleNsToUnixMs(appleNs)));
}

export function unixMsToAppleNs(unixMs: bigint): bigint {
  return (unixMs - APPLE_EPOCH_OFFSET_MS) * NS_PER_MS;
}

/** Raw row from the `message` table joined with handle + chat */
export interface ChatDbMessageRow {
  message_id: number;       // message.ROWID
  text: string | null;
  date: string;             // Apple epoch nanoseconds (stored as integer in SQLite)
  is_from_me: number;       // 0 or 1
  sender: string | null;    // handle.id (phone/email)
  chat_id: number | null;   // chat.ROWID
  chat_guid: string | null; // chat.guid e.g. "iMessage;+;chat123456"
  chat_identifier: string | null; // chat.chat_identifier
  display_name: string | null;    // chat.display_name (group name)
  associated_message_type: number; // 0=normal, 2000+=tapback
  service_name: string | null;     // chat.service_name ("iMessage" or "SMS")
  // Attachment fields (when joined)
  attachment_id?: number | null;
  attachment_filename?: string | null;
  attachment_mime_type?: string | null;
  attachment_total_bytes?: number | null;
}

/** Raw row from `chat` table */
export interface ChatDbChatRow {
  ROWID: number;
  guid: string;
  chat_identifier: string;
  display_name: string | null;
  service_name: string;
  style: number;            // 43 = DM, 45 = group
  // cache_roomnames is populated for group chats
  // but we do NOT filter on it (the interagents bug)
}

/** Raw row from `handle` table */
export interface ChatDbHandleRow {
  ROWID: number;
  id: string;               // Phone number or email
  service: string;           // "iMessage" or "SMS"
  uncanonicalized_id: string | null;
}

/** Raw row from `chat_handle_join` */
export interface ChatDbChatHandleRow {
  chat_id: number;           // FK to chat.ROWID
  handle_id: number;         // FK to handle.ROWID
}

/** Parsed/normalized message ready for processing */
export interface ParsedMessage {
  messageId: number;
  text: string;
  senderHandle: string | null;
  isFromMe: boolean;
  chatGuid: string;
  chatIdentifier: string;
  displayName: string | null;
  service: string;
  isGroup: boolean;
  appleTimestamp: bigint;
  createdAt: Date;
  associatedMessageType: number;
  isReaction: boolean;
  attachments: ParsedAttachment[];
}

export interface ParsedAttachment {
  attachmentId: number;
  filename: string;
  mimeType: string | null;
  totalBytes: number | null;
  normalizedPath: string;    // Absolute path after tilde expansion
}

/**
 * Determine if a chat is a group based on GUID.
 * ";+;" = group, ";-;" = DM
 */
export function isGroupFromGuid(guid: string): boolean {
  if (guid.includes(";+;")) return true;
  if (guid.includes(";-;")) return false;
  // Fallback: if chat_identifier starts with "chat", it's probably a group
  return false;
}

/**
 * Extract service from GUID prefix.
 */
export function serviceFromGuid(guid: string): string {
  const lower = guid.toLowerCase();
  if (lower.startsWith("imessage;")) return "iMessage";
  if (lower.startsWith("sms;")) return "SMS";
  return "unknown";
}

/**
 * Extract the identifier (3rd segment) from a chat GUID.
 * "iMessage;-;+1234567890" → "+1234567890"
 * "iMessage;+;chat123456" → "chat123456"
 */
export function identifierFromGuid(guid: string): string {
  const parts = guid.split(";");
  return parts[2]?.trim() || guid;
}
