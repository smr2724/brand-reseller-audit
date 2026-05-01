"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LayoutDashboard, Settings, LogOut, Menu, X, Zap, Building2, Upload, ClipboardCheck } from "lucide-react";

const NAV = [
  { href: "/app/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/app/brands", label: "Brands", icon: Building2 },
  { href: "/app/review", label: "Review", icon: ClipboardCheck },
  { href: "/app/imports", label: "Imports", icon: Upload },
  { href: "/app/settings", label: "Settings", icon: Settings },
];

export default function AppShell({ children, email }: { children: React.ReactNode; email?: string | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [queueSize, setQueueSize] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/reviews/stats", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setQueueSize(data.queue_remaining ?? 0);
      } catch {}
    }
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* Mobile top bar */}
      <header className="md:hidden flex items-center justify-between px-4 h-14 border-b border-[var(--border)] bg-[var(--bg-2)] sticky top-0 z-20">
        <div className="flex items-center gap-2">
          <Zap size={18} style={{ color: "var(--accent)" }} />
          <span className="font-semibold tracking-tight">Channel Scanner</span>
        </div>
        <button className="btn-ghost p-2" aria-label="Menu" onClick={() => setOpen(v => !v)}>
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </header>

      {/* Sidebar */}
      <aside
        className={`${open ? "block" : "hidden"} md:block md:w-56 md:min-h-screen md:border-r md:border-[var(--border)] md:bg-[var(--bg-2)] md:sticky md:top-0 md:h-screen`}
        style={{ flexShrink: 0 }}
      >
        <div className="hidden md:flex items-center gap-2 px-5 pt-5 pb-6">
          <Zap size={20} style={{ color: "var(--accent)" }} />
          <div>
            <div className="font-semibold tracking-tight leading-tight">Channel</div>
            <div className="text-[11px] text-[var(--text-muted)] leading-tight">Ownership Scanner</div>
          </div>
        </div>

        <nav className="px-2 flex flex-col gap-1 pb-4">
          {NAV.map(n => {
            const active = pathname === n.href || pathname.startsWith(n.href + "/");
            const Icon = n.icon;
            const showBadge = n.href === "/app/review" && queueSize !== null && queueSize > 0;
            return (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors"
                style={{
                  background: active ? "var(--bg-3)" : "transparent",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  border: active ? "1px solid var(--border)" : "1px solid transparent",
                }}
              >
                <Icon size={16} />
                <span className="flex-1">{n.label}</span>
                {showBadge && (
                  <span
                    className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                    style={{ background: "var(--accent)", color: "#0b0b0b" }}
                  >
                    {queueSize}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="px-4 py-3 md:absolute md:bottom-0 md:left-0 md:right-0 md:border-t md:border-[var(--border)]">
          <div className="text-[11px] text-[var(--text-muted)] truncate mb-2" title={email ?? ""}>{email ?? ""}</div>
          <form action="/api/auth/signout" method="POST">
            <button className="btn btn-ghost w-full justify-start text-xs" type="submit">
              <LogOut size={14} /> Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
