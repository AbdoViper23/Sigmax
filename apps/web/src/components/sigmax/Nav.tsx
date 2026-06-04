import { Link } from "@tanstack/react-router";
import sigmaxMark from "@/assets/sigmax-mark.svg";
import { ConnectButton } from "@rainbow-me/rainbowkit";

/**
 * Top nav. Wallet connection + chain switching are handled by RainbowKit's ConnectButton
 * (reads wagmi state). No props — it's global chrome rendered once in __root.
 */
const links = [
  { to: "/", label: "Home" },
  { to: "/leaderboard", label: "Leaders" },
  { to: "/leader", label: "Become a leader" },
  { to: "/follower", label: "My subscriptions" },
] as const;

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <img src={sigmaxMark} alt="Sigmax" className="h-6 w-6" />
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
          <ConnectButton showBalance={false} accountStatus="address" chainStatus="icon" />
        </div>
      </div>
    </header>
  );
}
