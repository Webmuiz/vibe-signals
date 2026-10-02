import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const res = await fetch('https://testnet.vibevibe.fun/api/v1/chains/46630/launches?limit=500', {
            cache: 'no-store'
        });
        
        if (!res.ok) {
            throw new Error(`API responded with status: ${res.status}`);
        }
        
        const data = await res.json();
        return NextResponse.json(data);
    } catch (error) {
        console.error("Proxy VibeVibe API error:", error);
        return NextResponse.json({ error: 'Failed to fetch from VibeVibe API' }, { status: 500 });
    }
}
