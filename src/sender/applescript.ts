/**
 * Send messages via AppleScript → Messages.app.
 * Always addresses by chat GUID for reliable routing.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

const execFile = promisify(execFileCb);

export interface SendOptions {
  /** The chat GUID to send to (e.g., "iMessage;-;+1234567890" or "iMessage;+;chat123456") */
  chatGuid: string;
  /** Text message body */
  text?: string;
  /** Path to file attachment */
  filePath?: string;
  /** Timeout in milliseconds */
  timeoutMs?: number;
}

export interface SendResult {
  success: boolean;
  error?: string;
}

/**
 * Send a message to a chat via AppleScript.
 * Uses `chat id` addressing so it works for both DMs and groups.
 */
export async function sendMessage(options: SendOptions): Promise<SendResult> {
  const { chatGuid, text, filePath, timeoutMs = 30_000 } = options;

  if (!chatGuid) {
    return { success: false, error: "chatGuid is required" };
  }
  if (!text && !filePath) {
    return { success: false, error: "text or filePath is required" };
  }

  const escapedGuid = escapeAppleScript(chatGuid);
  const scriptParts: string[] = [];

  scriptParts.push(`tell application "Messages"`);
  scriptParts.push(`  set theChat to chat id "${escapedGuid}"`);

  if (text) {
    scriptParts.push(`  send "${escapeAppleScript(text)}" to theChat`);
  }

  if (filePath) {
    // Stage the file for Messages.app's sandbox
    const stagedPath = await stageFileForMessages(filePath);
    scriptParts.push(
      `  set theAttachment to POSIX file "${escapeAppleScript(stagedPath)}" as alias`,
    );
    scriptParts.push(`  send theAttachment to theChat`);
  }

  scriptParts.push(`end tell`);
  const script = scriptParts.join("\n");

  try {
    await execFile("/usr/bin/osascript", ["-e", script], {
      timeout: timeoutMs,
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Send a message to a new handle (phone/email) where we don't have a chat GUID yet.
 * This creates a new conversation. Use sparingly — prefer chatGuid when available.
 */
export async function sendToHandle(
  handle: string,
  text: string,
  service: "iMessage" | "SMS" = "iMessage",
  timeoutMs = 30_000,
): Promise<SendResult> {
  const escapedHandle = escapeAppleScript(handle);
  const escapedText = escapeAppleScript(text);

  const script = [
    `tell application "Messages"`,
    `  set targetService to 1st service whose service type is ${service}`,
    `  set targetBuddy to buddy "${escapedHandle}" of targetService`,
    `  send "${escapedText}" to targetBuddy`,
    `end tell`,
  ].join("\n");

  try {
    await execFile("/usr/bin/osascript", ["-e", script], {
      timeout: timeoutMs,
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Fallback: try without specifying service
    try {
      const fallbackScript = [
        `tell application "Messages"`,
        `  send "${escapedText}" to buddy "${escapedHandle}"`,
        `end tell`,
      ].join("\n");
      await execFile("/usr/bin/osascript", ["-e", fallbackScript], {
        timeout: timeoutMs,
      });
      return { success: true };
    } catch (err2) {
      return {
        success: false,
        error: `Primary: ${message}. Fallback: ${err2 instanceof Error ? err2.message : String(err2)}`,
      };
    }
  }
}

/**
 * Stage a file into ~/Pictures/OpenClawOutbound/ so Messages.app's
 * sandboxed `imagent` process can read it.
 */
async function stageFileForMessages(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const stageDir = path.join(os.homedir(), "Pictures", "OpenClawOutbound");
  const ext = path.extname(resolved) || "";
  const rand = Math.random().toString(16).slice(2);
  const outName = `bridge-${Date.now()}-${rand}${ext}`;
  const outPath = path.join(stageDir, outName);

  await fs.mkdir(stageDir, { recursive: true });
  await fs.copyFile(resolved, outPath);

  // Clean up old staged files (>24h)
  try {
    const entries = await fs.readdir(stageDir, { withFileTypes: true });
    const now = Date.now();
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.startsWith("bridge-")) continue;
      const full = path.join(stageDir, ent.name);
      const st = await fs.stat(full).catch(() => null);
      if (st && now - st.mtimeMs > 24 * 60 * 60 * 1000) {
        await fs.unlink(full).catch(() => {});
      }
    }
  } catch {
    // ignore cleanup errors
  }

  return outPath;
}

function escapeAppleScript(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}
