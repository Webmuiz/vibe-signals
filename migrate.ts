import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();
import { createClient } from '@libsql/client';

const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
});

async function columnExists(table: string, column: string): Promise<boolean> {
    const res = await db.execute({
        sql: `SELECT name FROM pragma_table_info(?)`,
        args: [table],
    });
    return res.rows.some((r) => String(r.name) === column);
}

async function main() {
    // `sniper_wallets` stores a JSON.stringify()'d array of wallet addresses,
    // so it is TEXT with a default of '[]' (empty JSON array).
    if (!(await columnExists('launches', 'sniper_wallets'))) {
        await db.execute({
            sql: `ALTER TABLE launches ADD COLUMN sniper_wallets TEXT DEFAULT '[]'`,
            args: [],
        });
        console.log("✓ Added column sniper_wallets TEXT DEFAULT '[]' to launches.");
    } else {
        console.log('✓ Column sniper_wallets already exists — skipping.');
    }

    // `pair_currency_address` is the AUTHORITATIVE quote-asset key used for USD
    // rate lookups. `pair_symbol` can be null (e.g. MOBLAND) or mislabeled, so
    // the address must be persisted and surfaced to the frontend.
    if (!(await columnExists('launches', 'pair_currency_address'))) {
        await db.execute({
            sql: `ALTER TABLE launches ADD COLUMN pair_currency_address TEXT`,
            args: [],
        });
        console.log('✓ Added column pair_currency_address TEXT to launches.');
    } else {
        console.log('✓ Column pair_currency_address already exists — skipping.');
    }

    // Verify.
    const res = await db.execute({
        sql: `SELECT name, type, dflt_value FROM pragma_table_info('launches') WHERE name IN ('sniper_wallets', 'pair_currency_address')`,
        args: [],
    });
    console.log('Verification:', res.rows.map((r) => `${r.name} | ${r.type} | default=${r.dflt_value}`));
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
});
