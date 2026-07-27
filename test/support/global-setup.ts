import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { TEST_DB_HOST, TEST_DB_PORT } from "./test-db-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "db", "migrations");

/**
 * Real Postgres (compiled to WASM via PGlite) exposed over an actual wire-protocol
 * TCP socket, so every module under test connects through the ordinary `pg` Pool —
 * no mocking of SQL, transactions, or FOR UPDATE SKIP LOCKED semantics. This is what
 * lets the concurrency/idempotency tests exercise the real queries instead of a
 * hand-rolled substitute for Postgres. No docker/system Postgres install required.
 */
export default async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    await db.exec(sql);
  }

  const server = new PGLiteSocketServer({ db, host: TEST_DB_HOST, port: TEST_DB_PORT, maxConnections: 20 });
  await server.start();

  return async () => {
    await server.stop();
    await db.close();
  };
}
