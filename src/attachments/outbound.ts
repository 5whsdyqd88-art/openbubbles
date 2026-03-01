/**
 * Outbound attachment handling:
 * When an OpenClaw agent sends a file, we stage it for Messages.app.
 *
 * imagent (Apple's messaging daemon) is sandboxed and can't read arbitrary paths.
 * We copy files to ~/Pictures/OpenClawOutbound/ where imagent can access them.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const STAGE_DIR = path.join(os.homedir(), "Pictures", "OpenClawBridgeOutbound");
const STAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Stage a file for sending via Messages.app.
 * Returns the staged path that can be used in AppleScript.
 */
export async function stageOutboundFile(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved) || "";
  const rand = Math.random().toString(16).slice(2);
  const outName = `bridge-out-${Date.now()}-${rand}${ext}`;
  const outPath = path.join(STAGE_DIR, outName);

  await fs.mkdir(STAGE_DIR, { recursive: true });
  await fs.copyFile(resolved, outPath);

  // Best-effort cleanup of old staged files
  cleanupOldStaged().catch(() => {});

  return outPath;
}

async function cleanupOldStaged(): Promise<void> {
  const entries = await fs.readdir(STAGE_DIR, { withFileTypes: true });
  const now = Date.now();
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.startsWith("bridge-out-")) continue;
    const full = path.join(STAGE_DIR, ent.name);
    const st = await fs.stat(full).catch(() => null);
    if (st && now - st.mtimeMs > STAGE_TTL_MS) {
      await fs.unlink(full).catch(() => {});
    }
  }
}
