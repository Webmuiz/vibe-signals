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
    if (await columnExists('launches', 'sniper_wallets')) {
        console.log('✓ Column sniper_wallets already exists — nothing to do.');
        return;
    }

    await db.execute({
        sql: `ALTER TABLE launches ADD COLUMN sniper_wallets TEXT DEFAULT '[]'`,
        args: [],
    });
    console.log("✓ Added column sniper_wallets TEXT DEFAULT '[]' to launches.");

    // Verify.
    const res = await db.execute({
        sql: `SELECT name, type, dflt_value FROM pragma_table_info('launches') WHERE name = 'sniper_wallets'`,
        args: [],
    });
    console.log('Verification:', res.rows.map((r) => `${r.name} | ${r.type} | default=${r.dflt_value}`));
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
});
