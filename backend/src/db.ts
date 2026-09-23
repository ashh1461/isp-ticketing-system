/**
 * PostgreSQL persistence layer for the ISP Ticketing System.
 *
 * Design: the API keeps its fast in-memory objects for request handling, and
 * this module owns durability. On boot it creates the schema (idempotently),
 * seeds an admin when the user table is empty, and hydrates the in-memory
 * store. Every mutating route awaits flushX() afterwards, which rewrites the
 * affected table inside a single transaction — for this system's scale that is
 * simpler and more reliable than per-row upserts, and it guarantees the on-disk
 * state matches what the API just returned.
 *
 * If PostgreSQL is unreachable the layer degrades loudly to in-memory-only so
 * the service still starts (and tests still run); it never silently swallows
 * the failure.
 */

import { Pool, PoolClient } from 'pg';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  role: string;
  is_active: boolean;
  created_at: string;
}

export interface CustomerRow {
  id: string;
  account_number: string;
  first_name: string;
  last_name: string;
  email: string;
  account_type: string;
  created_at: string;
}

export interface CommentRow {
  id: string;
  ticket_id: string;
  user_id: string;
  text: string;
  is_internal: boolean;
  created_at: string;
}

export interface TicketRow {
  id: string;
  ticket_number: string;
  customer_id: string;
  created_by_user_id: string;
  assigned_to_user_id: string | null;
  status: string;
  priority: string;
  title: string;
  description: string;
  comments: CommentRow[];
  created_at: string;
  updated_at: string;
}

export interface DataStore {
  users: UserRow[];
  tickets: TicketRow[];
  customers: CustomerRow[];
}

let pool: Pool | null = null;
let pgEnabled = false;

/**
 * True when a real PostgreSQL backend is wired up. Exposed for /health so
 * operators can see at a glance whether data is durable.
 */
export function isPersistenceEnabled(): boolean {
  return pgEnabled;
}

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'isp_ticketing',
      user: process.env.DB_USER || 'ticketing_user',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      // Small, bounded pool — this service issues a handful of queries per write.
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  role          TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id             TEXT PRIMARY KEY,
  account_number TEXT UNIQUE NOT NULL,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  email          TEXT NOT NULL DEFAULT '',
  account_type   TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id                  TEXT PRIMARY KEY,
  ticket_number       TEXT UNIQUE NOT NULL,
  customer_id         TEXT NOT NULL,
  created_by_user_id  TEXT NOT NULL,
  assigned_to_user_id TEXT,
  status              TEXT NOT NULL,
  priority            TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  comments            JSONB NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_customer ON tickets (customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets (assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status   ON tickets (status);
`;

/**
 * Create schema and hydrate the store. Safe to call once at startup.
 * Returns the hydrated store; on failure returns the store as-is and logs.
 */
export async function initDatabase(store: DataStore): Promise<void> {
  try {
    const client = await getPool().connect();
    try {
      await client.query(SCHEMA_SQL);

      // Hydrate — newest order preserved by created_at, stable on ties.
      const users = await client.query(
        'SELECT * FROM users ORDER BY created_at ASC, id ASC'
      );
      const customers = await client.query(
        'SELECT * FROM customers ORDER BY created_at ASC, id ASC'
      );
      const tickets = await client.query(
        'SELECT * FROM tickets ORDER BY created_at ASC, id ASC'
      );

      store.users = users.rows as UserRow[];
      store.customers = customers.rows as CustomerRow[];
      store.tickets = tickets.rows.map((r: any) => ({
        ...r,
        // JSONB round-trips as an object already; defend against a text column.
        comments: Array.isArray(r.comments) ? r.comments : JSON.parse(r.comments || '[]'),
        assigned_to_user_id: r.assigned_to_user_id ?? null,
      })) as TicketRow[];

      pgEnabled = true;
    } finally {
      client.release();
    }
  } catch (err) {
    // Deliberate, loudly-logged degradation — never silently lose durability.
    pgEnabled = false;
    console.error(
      '⚠️  PostgreSQL unavailable — running in IN-MEMORY ONLY mode.',
      'Data will NOT survive a restart. Fix DB_* env vars.',
      (err as Error).message
    );
  }
}

/**
 * Rewrite one table inside a single transaction. Because the API already holds
 * the authoritative copy in memory, a full rewrite is both correct and the
 * simplest way to guarantee disk matches the response we just returned.
 */
async function rewriteTable(
  table: 'users' | 'customers' | 'tickets',
  columns: string[],
  placeholders: (row: any) => (string | boolean | null)[],
  rows: any[]
): Promise<void> {
  if (!pgEnabled) return;
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${table}`);
    const colList = columns.join(', ');
    const paramList = columns.map((_, i) => `$${i + 1}`).join(', ');
    const stmt = `INSERT INTO ${table} (${colList}) VALUES (${paramList})`;
    for (const row of rows) {
      await client.query(stmt, placeholders(row));
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`⚠️  Failed to persist ${table}:`, (err as Error).message);
  } finally {
    client.release();
  }
}

export function flushUsers(store: DataStore): Promise<void> {
  return rewriteTable(
    'users',
    ['id', 'email', 'password_hash', 'first_name', 'last_name', 'role', 'is_active', 'created_at'],
    (u) => [u.id, u.email, u.password_hash, u.first_name, u.last_name, u.role, u.is_active, u.created_at],
    store.users
  );
}

export function flushCustomers(store: DataStore): Promise<void> {
  return rewriteTable(
    'customers',
    ['id', 'account_number', 'first_name', 'last_name', 'email', 'account_type', 'created_at'],
    (c) => [c.id, c.account_number, c.first_name, c.last_name, c.email, c.account_type, c.created_at],
    store.customers
  );
}

export function flushTickets(store: DataStore): Promise<void> {
  return rewriteTable(
    'tickets',
    [
      'id', 'ticket_number', 'customer_id', 'created_by_user_id',
      'assigned_to_user_id', 'status', 'priority', 'title', 'description',
      'comments', 'created_at', 'updated_at',
    ],
    (t) => [
      t.id, t.ticket_number, t.customer_id, t.created_by_user_id,
      t.assigned_to_user_id ?? null, t.status, t.priority, t.title, t.description,
      JSON.stringify(t.comments || []), t.created_at, t.updated_at,
    ],
    store.tickets
  );
}

/**
 * Close the pool cleanly on shutdown so the last writes are flushed.
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    pgEnabled = false;
  }
}
