import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const res = await fetch('https://testnet.vibevibe.fun/api/v1/chains/46630/v6/pair-prices', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store'
    });
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch pair prices' }, { status: res.status });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
