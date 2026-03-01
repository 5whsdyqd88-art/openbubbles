/**
 * Inbound attachment pipeline:
 * 1. Copy from Apple's ~/Library/Messages/Attachments/ to our managed storage
 * 2. Convert HEIC → JPEG if needed
 * 3. Track everything in Postgres
 *
 * Why copy? Apple's attachment paths are deep, permission-gated, and macOS
 * can purge them. We need our own stable copies.
 */

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { attachments } from "../db/schema.js";

const execFile = promisify(execFileCb);

/** Where we store our own copies of attachments */
const MEDIA_BASE_DIR = path.join(os.homedir(), ".openclaw", "imessage-bridge", "media");
const INBOUND_DIR = path.join(MEDIA_BASE_DIR, "inbound");

export interface ProcessedAttachment {
  /** Our Postgres attachment ID */
  id: number;
  /** Path to the usable file (converted if needed) */
  localPath: string;
  /** MIME type of the usable file */
  mimeType: string;
  /** Original filename */
  filename: string;
  /** File size in bytes */
  sizeBytes: number;
}

/**
 * Process all pending attachments for a message.
 * Copies from Apple's storage, converts HEIC, updates Postgres.
 */
export async function processInboundAttachments(
  db: PostgresJsDatabase,
  messageId: number,
  log?: (msg: string) => void,
): Promise<ProcessedAttachment[]> {
  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.messageId, messageId));

  const results: ProcessedAttachment[] = [];

  for (const att of rows) {
    if (!att.originalPath) continue;

    try {
      const processed = await processOneAttachment(att, log);
      if (processed) {
        // Update Postgres with our local copy info
        await db
          .update(attachments)
          .set({
            convertedPath: processed.localPath,
            mimeType: processed.mimeType,
            sizeBytes: processed.sizeBytes,
            conversionStatus: processed.wasConverted ? "converted" : "none",
          })
          .where(eq(attachments.id, att.id));

        results.push({
          id: att.id,
          localPath: processed.localPath,
          mimeType: processed.mimeType,
          filename: processed.filename,
          sizeBytes: processed.sizeBytes,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.(`attachment ${att.id} failed: ${errMsg}`);

      await db
        .update(attachments)
        .set({ conversionStatus: "failed" })
        .where(eq(attachments.id, att.id));
    }
  }

  return results;
}

interface InternalProcessedAttachment {
  localPath: string;
  mimeType: string;
  filename: string;
  sizeBytes: number;
  wasConverted: boolean;
}

async function processOneAttachment(
  att: typeof attachments.$inferSelect,
  log?: (msg: string) => void,
): Promise<InternalProcessedAttachment | null> {
  const originalPath = att.originalPath!;

  // Check if the source file exists
  try {
    await fs.access(originalPath);
  } catch {
    log?.(`attachment source not accessible: ${originalPath}`);
    return null;
  }

  // Ensure our media directory exists
  await fs.mkdir(INBOUND_DIR, { recursive: true });

  const ext = path.extname(originalPath).toLowerCase();
  const basename = path.basename(originalPath);
  const needsConversion = isHeic(ext, att.mimeType);

  if (needsConversion) {
    return await convertHeicToJpeg(originalPath, att.id, basename, log);
  }

  // No conversion needed — just copy to our storage
  const destFilename = `${att.id}-${sanitizeFilename(basename)}`;
  const destPath = path.join(INBOUND_DIR, destFilename);

  // Skip if already copied
  try {
    const st = await fs.stat(destPath);
    if (st.isFile() && st.size > 0) {
      return {
        localPath: destPath,
        mimeType: att.mimeType || inferMimeType(ext),
        filename: basename,
        sizeBytes: st.size,
        wasConverted: false,
      };
    }
  } catch {
    // Not yet copied
  }

  await fs.copyFile(originalPath, destPath);
  const st = await fs.stat(destPath);

  return {
    localPath: destPath,
    mimeType: att.mimeType || inferMimeType(ext),
    filename: basename,
    sizeBytes: st.size,
    wasConverted: false,
  };
}

/**
 * Convert HEIC/HEIF → JPEG using macOS sips (built-in, no dependencies).
 * Falls back to ImageMagick if sips fails.
 */
async function convertHeicToJpeg(
  sourcePath: string,
  attachmentId: number,
  originalName: string,
  log?: (msg: string) => void,
): Promise<InternalProcessedAttachment | null> {
  const destFilename = `${attachmentId}-${sanitizeFilename(originalName).replace(/\.heic$/i, ".jpg").replace(/\.heif$/i, ".jpg")}`;
  const destPath = path.join(INBOUND_DIR, destFilename);

  // Skip if already converted
  try {
    const st = await fs.stat(destPath);
    if (st.isFile() && st.size > 0) {
      return {
        localPath: destPath,
        mimeType: "image/jpeg",
        filename: destFilename,
        sizeBytes: st.size,
        wasConverted: true,
      };
    }
  } catch {
    // Not yet converted
  }

  // Try sips first (built into macOS)
  try {
    await execFile("/usr/bin/sips", ["-s", "format", "jpeg", sourcePath, "--out", destPath], {
      timeout: 30_000,
    });
    const st = await fs.stat(destPath);
    if (st.isFile() && st.size > 0) {
      log?.(`converted HEIC → JPEG: ${originalName}`);
      return {
        localPath: destPath,
        mimeType: "image/jpeg",
        filename: destFilename,
        sizeBytes: st.size,
        wasConverted: true,
      };
    }
  } catch {
    // sips failed, try ImageMagick
  }

  // Fallback: ImageMagick
  try {
    await execFile("/usr/bin/env", ["magick", "convert", sourcePath, "-quality", "85", destPath], {
      timeout: 30_000,
    });
    const st = await fs.stat(destPath);
    if (st.isFile() && st.size > 0) {
      log?.(`converted HEIC → JPEG (ImageMagick): ${originalName}`);
      return {
        localPath: destPath,
        mimeType: "image/jpeg",
        filename: destFilename,
        sizeBytes: st.size,
        wasConverted: true,
      };
    }
  } catch {
    // Both converters failed
  }

  log?.(`HEIC conversion failed for ${originalName}, falling back to raw copy`);

  // Last resort: copy as-is
  await fs.copyFile(sourcePath, destPath.replace(/\.jpg$/, ".heic"));
  const fallbackPath = destPath.replace(/\.jpg$/, ".heic");
  const st = await fs.stat(fallbackPath);
  return {
    localPath: fallbackPath,
    mimeType: "image/heic",
    filename: path.basename(fallbackPath),
    sizeBytes: st.size,
    wasConverted: false,
  };
}

function isHeic(ext: string, mimeType: string | null): boolean {
  const lower = ext.toLowerCase();
  if (lower === ".heic" || lower === ".heif") return true;
  if (mimeType?.toLowerCase().includes("heic")) return true;
  if (mimeType?.toLowerCase().includes("heif")) return true;
  return false;
}

function inferMimeType(ext: string): string {
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".vcf": "text/vcard",
  };
  return map[ext.toLowerCase()] || "application/octet-stream";
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Get the media base directory path (for the API to serve files).
 */
export function getMediaDir(): string {
  return MEDIA_BASE_DIR;
}

export function getInboundDir(): string {
  return INBOUND_DIR;
}
