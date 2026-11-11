/**
 * Indexer storage. Uses Bun's SQL client, so the same code runs on SQLite (default, a local file, good
 * for development and single-node deployments) and Postgres (set DATABASE_URL=postgres://...).
 * Amounts are stored as decimal strings so values above 2^63 survive both engines.
 * On a container or VM, put the SQLite file (or the Postgres data) on a durable volume.
 */
import { SQL } from 'bun'
import fs from 'node:fs'
import path from 'node:path'

export type Db = SQL

export function defaultDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? 'sqlite://./data/indexer.db'
}

export async function openDb(url: string = defaultDatabaseUrl()): Promise<Db> {
  if (url.startsWith('sqlite://') && !url.includes(':memory:')) {
    const file = url.slice('sqlite://'.length)
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }
  const db = new SQL(url)
  await migrate(db)
  return db
}

export async function migrate(db: Db): Promise<void> {
  await db`create table if not exists meta (key text primary key, value text not null)`
  await db`create table if not exists events (
    id text primary key,
    chain_id integer not null,
    contract text not null,
    block_number integer not null,
    block_time integer not null,
    tx_hash text not null,
    log_index integer not null,
    name text not null,
    owner text,
    item_id text,
    args text not null
  )`
  await db`create index if not exists events_owner on events (chain_id, owner, block_number)`
  await db`create index if not exists events_item on events (chain_id, name, item_id)`
  await db`create table if not exists swaps (
    chain_id integer not null,
    tx_hash text not null,
    owner text not null,
    target text not null,
    sell_token text not null,
    sell_amount text not null,
    buy_token text not null,
    buy_amount text not null,
    block_number integer not null,
    block_time integer not null,
    primary key (chain_id, tx_hash)
  )`
  await db`create index if not exists swaps_owner on swaps (chain_id, owner, block_number)`
}

export async function getMeta(db: Db, key: string): Promise<string | null> {
  const rows = (await db`select value from meta where key = ${key}`) as { value: string }[]
  return rows[0]?.value ?? null
}

export async function setMeta(db: Db, key: string, value: string): Promise<void> {
  await db`insert into meta (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value`
}
