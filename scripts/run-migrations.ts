/**
 * Turso migration runner.
 *
 * Applies every `*.sql` file in `scripts/migrations/` in filename order against
 * the database configured by TURSO_DATABASE_URL / TURSO_AUTH_TOKEN.
 *
 * Usage:
 *   npx tsx scripts/run-migrations.ts            # apply pending migrations
 *   npx tsx scripts/run-migrations.ts --dry-run  # list what would run
 *   npx tsx scripts/run-migrations.ts 002        # apply a single migration by prefix
 *
 * Applied migrations are recorded in `_migrations` so re-runs are no-ops.
 * Migration files themselves are written to be idempotent (IF NOT EXISTS).
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { createClient } from '@libsql/client';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const MIGRATIONS_DIR = path.join(process.cwd(), 'scripts', 'migrations');

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
    console.error('✗ TURSO_DATABASE_URL is not set (checked .env.local and process env).');
    process.exit(1);
}

const db = createClient({ url, authToken });

/** Split a SQL file into individual statements, ignoring comments and blank lines. */
function splitStatements(sql: string): string[] {
    return sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
}

async function ensureMigrationsTable(): Promise<void> {
    await db.execute({
        sql: `CREATE TABLE IF NOT EXISTS _migrations (
            name TEXT PRIMARY KEY,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
        args: [],
    });
}

async function appliedMigrations(): Promise<Set<string>> {
    const res = await db.execute({ sql: `SELECT name FROM _migrations`, args: [] });
    return new Set(res.rows.map((row) => String(row.name)));
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const filter = args.find((arg) => !arg.startsWith('--'));

    await ensureMigrationsTable();
    const applied = await appliedMigrations();

    const files = (await readdir(MIGRATIONS_DIR))
        .filter((file) => file.endsWith('.sql'))
        .filter((file) => (filter ? file.startsWith(filter) : true))
        .sort();

    if (files.length === 0) {
        console.log('No migration files matched.');
        return;
    }

    let ran = 0;
    for (const file of files) {
        if (applied.has(file)) {
            console.log(`• ${file} — already applied, skipping.`);
            continue;
        }

        const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
        const statements = splitStatements(sql);

        if (dryRun) {
            console.log(`• ${file} — would run ${statements.length} statement(s).`);
            continue;
        }

        console.log(`→ Applying ${file} (${statements.length} statement(s))...`);
        for (const statement of statements) {
            await db.execute({ sql: statement, args: [] });
        }
        await db.execute({
            sql: `INSERT OR REPLACE INTO _migrations (name) VALUES (?)`,
            args: [file],
        });
        console.log(`✓ ${file} applied.`);
        ran += 1;
    }

    console.log(dryRun ? 'Dry run complete.' : `Done. ${ran} migration(s) applied.`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Migration failed:', error);
        process.exit(1);
    });
