import { Button } from "@/components/ui/button";

/**
 * Presentational placeholder. The web3 layer will replace internals with RainbowKit.
 * Props mirror the eventual connected state so the rest of the UI can be built.
 */
export interface ConnectButtonProps {
  address?: string;
  chainLabel?: string;
  onConnect?: () => Promise<void> | void;
  onDisconnect?: () => Promise<void> | void;
}

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function ConnectButton({
  address,
  chainLabel,
  onConnect,
  onDisconnect,
}: ConnectButtonProps) {
  if (address) {
    return (
      <button
        onClick={() => onDisconnect?.()}
        className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
      >
        {chainLabel && <span className="text-xs text-muted-foreground">{chainLabel}</span>}
        <span className="font-mono">{short(address)}</span>
      </button>
    );
  }
  return (
    <Button size="sm" onClick={() => onConnect?.()}>
      Connect wallet
    </Button>
  );
}
