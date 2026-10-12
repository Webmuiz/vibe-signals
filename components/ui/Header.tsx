import React from "react";

interface HeaderProps {
  ready: boolean;
  authenticated: boolean;
  isConnected: boolean;
  address?: string;
  login: () => void;
  logout: () => void;
  /** Opens the User Portfolio drawer. Only meaningful when connected. */
  onOpenPortfolio?: () => void;
}

export default function Header({
  ready,
  authenticated,
  isConnected,
  address,
  login,
  logout,
  onOpenPortfolio
}: HeaderProps) {
  return (
    <nav className="flex justify-between items-center p-4 border-b border-zinc-800 bg-zinc-900/50 sticky top-0 z-50 backdrop-blur-md">
      <div>
        <h1 className="text-xl font-bold text-emerald-400">Vibe Signals</h1>
        <span className="text-xs text-zinc-500">Robinhood Chain Testnet | High-Speed Node</span>
      </div>
      <div className="flex items-center gap-3">
        {(!ready || (!authenticated && !isConnected)) ? (
          <button
            onClick={login}
            disabled={!ready}
            className="px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold rounded-lg transition-colors text-sm disabled:opacity-50"
          >
            Log In / Connect
          </button>
        ) : (
          <div className="flex items-center gap-3">
            {onOpenPortfolio && (
              <button
                onClick={onOpenPortfolio}
                className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold rounded-lg transition-colors text-sm border border-zinc-700 hover:border-emerald-500/50"
              >
                💼 Portfolio
              </button>
            )}
            <span className="text-sm font-mono text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-lg border border-emerald-500/30">
              {address ? `${address.substring(0, 6)}...${address.substring(address.length - 4)}` : ""}
            </span>
            <button
              onClick={logout}
              className="px-4 py-2 bg-zinc-800 hover:bg-red-500 hover:text-white text-zinc-400 font-bold rounded-lg transition-colors text-sm border border-zinc-700 hover:border-red-500"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
