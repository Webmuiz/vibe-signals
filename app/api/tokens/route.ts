import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

// 🛑 PASTE YOUR CREDENTIALS HERE
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

export async function GET() {
    try {
        const { data, error } = await supabase
            .from('launches')
            .select('*')
            .order('launch_id', { ascending: false })
            .limit(50);

        if (error) throw error;

        // Map the Supabase columns back to the camelCase variables your frontend expects
        const formattedData = data.map(db => ({
            launchId: db.launch_id,
            tokenAddress: db.token_address,
            ammAddress: db.amm_address,
            devAddress: db.dev_address,
            ethDeposited: db.liquidity_deposited,
            pairSymbol: db.pair_symbol || 'ETH',
            curveProgress: db.curve_progress,
            launchBlock: db.launch_block,
            timestamp: db.created_at,
            name: db.name || `Token #${db.launch_id}`, // Pull real name
            ticker: db.symbol ? `$${db.symbol}` : '$TKN' // Pull real ticker
        }));

        return NextResponse.json(formattedData);
    } catch (error) {
        console.error("Failed to read Supabase:", error);
        return NextResponse.json([]);
    }
}