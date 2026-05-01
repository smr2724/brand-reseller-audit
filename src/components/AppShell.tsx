"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { LayoutDashboard, Plus, List, Factory, Settings, LogOut, Menu, X, Zap, Handshake, Layers, History, Users } from "lucide-react";

const NAV = [
  { href: "/app/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/app/scan", label: "New Scan", icon: Plus },
  { href: "/app/scan/batch", label: "Batch Scan", icon: Layers },
  { href: "/app/sweeps", label: "Sweeps", icon: History },
  { href: "/app/review", label: "Review Queue", icon: List },
  { href: "/app/suppliers", label: "Suppliers", icon: Handshake },
  { href: "/app/crm", label: "CRM", icon: Users },
  { href: "/app/manufacturers", label: "Manufacturers", icon: Factory },
  { href: "/app/settings", label: "Settings", icon: Settings },
];

export default function AppShell({ children, email }: { children: React.ReactNode; email?: string | null }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* Mobile top bar */}
      <header className="md:hidden flex items-center justify-between px-4 h-14 border-b border-[var(--border)] bg-[var(--bg-2)] sticky top-0 z-20">
        <div className="flex items-center gap-2">
          <Zap size={18} style={{ color: "var(--accent)" }} />
          <span className="font-semibold tracking-tight">Legion Scanner</span>
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
            <div className="font-semibold tracking-tight leading-tight">Legion</div>
            <div className="text-[11px] text-[var(--text-muted)] leading-tight">Opportunity Scanner</div>
          </div>
        </div>

        <nav className="px-2 flex flex-col gap-1 pb-4">
          {NAV.map(n => {
            const active = pathname === n.href || pathname.startsWith(n.href + "/");
            const Icon = n.icon;
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
                <span>{n.label}</span>
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
