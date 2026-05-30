import { Link } from "@tanstack/react-router";
import { ConnectButton } from "./ConnectButton";
import { NetworkBadge, type ChainId } from "./NetworkBadge";

/**
 * Top nav. Wallet state + chain are placeholders driven by props (mocked in pages).
 */
export interface NavProps {
  address?: string;
  chain?: ChainId;
}

const links = [
  { to: "/", label: "Home" },
  { to: "/leaderboard", label: "Leaderboard" },
  { to: "/leader", label: "Leader" },
  { to: "/follower", label: "Follower" },
] as const;

export function Nav({ address, chain = "story" }: NavProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-6 w-6 place-items-center rounded-sm bg-foreground text-background">
            <span className="text-[11px] font-bold">Σ</span>
          </span>
          Sigmax
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              activeProps={{ className: "bg-accent text-foreground" }}
              activeOptions={{ exact: l.to === "/" }}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {address && <NetworkBadge chain={chain} />}
          <ConnectButton address={address} chainLabel={undefined} />
        </div>
      </div>
    </header>
  );
}
