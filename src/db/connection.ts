/**
 * Postgres connection via postgres.js + Drizzle ORM.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

let sqlClient: ReturnType<typeof postgres> | null = null;
let dbInstance: PostgresJsDatabase | null = null;

export function getDb(
  databaseUrl?: string,
): PostgresJsDatabase {
  if (dbInstance) return dbInstance;

  const url =
    databaseUrl ||
    process.env.DATABASE_URL ||
    "postgresql://computer@localhost:5432/imessage_bridge";

  sqlClient = postgres(url);
  dbInstance = drizzle(sqlClient);
  return dbInstance;
}

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end();
    sqlClient = null;
    dbInstance = null;
  }
}
