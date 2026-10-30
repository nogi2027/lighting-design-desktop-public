import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteD1Database } from '../scripts/sqlite-d1-adapter.mjs';
import { configureDefaultState, defaultState } from '../lib/default-state';
import { env } from './cloud-env';
import { seedSyncWorkspace, loadSyncProjection, readSyncHead } from '../lib/sync-v2/server-storage';
import * as bootstrap from '../app/api/sync/bootstrap/route';
import * as events from '../app/api/sync/events/route';
import * as operations from '../app/api/sync/operations/route';
import * as text from '../app/api/sync/text/[cueId]/route';
import * as history from '../app/api/sync/history/[cueId]/route';
import { validWorkspaceState } from '../lib/workspace-state';
import type { WorkspaceState } from '../lib/types';

let sqlite: DatabaseSync | undefined;
export async function initialize(file: string, state: WorkspaceState, migrationDirectory: string) {
  close();
  configureDefaultState(state);
  sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON');
  if (!(sqlite.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) {
    for (const name of fs.readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort())
      sqlite.exec(fs.readFileSync(path.join(migrationDirectory, name), 'utf8'));
    sqlite.exec('PRAGMA user_version=1');
  }
  env.DB = new SqliteD1Database(sqlite) as unknown as D1Database;
  if (!await readSyncHead(env.DB)) await seedSyncWorkspace(env.DB, defaultState, { writeMode: 'enabled' });
  const loaded = (await loadSyncProjection(env.DB)).state;
  if (!validWorkspaceState(loaded) || loaded.profiles.length !== 1 || loaded.profiles[0].id !== 'local') throw new Error('The local show database is invalid.');
}
export async function projection() { return (await loadSyncProjection(env.DB)).state; }
export async function route(request: Request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/sync/bootstrap') return bootstrap.GET(request);
  if (pathname === '/api/sync/events') return events.GET(request);
  if (pathname === '/api/sync/operations' && request.method === 'POST') return operations.POST(request);
  const match = /^\/api\/sync\/(text|history)\/([^/]+)$/.exec(pathname);
  if (match) return (match[1] === 'text' ? text.GET : history.GET)(request, { params: Promise.resolve({ cueId: decodeURIComponent(match[2]) }) });
  return Response.json({ error: 'This service is available only inside the local workspace.' }, { status: 404 });
}
export function close() { sqlite?.close(); sqlite = undefined; }
