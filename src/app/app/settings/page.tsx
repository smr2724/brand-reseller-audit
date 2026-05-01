"use client";
import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Check, X, RefreshCw, Mail, LogOut, ExternalLink } from "lucide-react";

type ProviderKey = "supabase" | "dataforseo" | "keepa" | "openai" | "apollo" | "outlook";

type OutlookMode = "oauth" | "legacy_env" | "none";
interface OutlookStatus {
  mode: OutlookMode;
  connected: boolean;
  account_email: string | null;
  oauth_app_configured: boolean;
}

export default function SettingsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const msStatus = params.get("ms_status");
  const msError = params.get("ms_error");

  const [configured, setConfigured] = useState<Record<ProviderKey, boolean>>({
    supabase: true, dataforseo: false, keepa: false, openai: false, apollo: false, outlook: false,
  });
  // null = still loading. Avoid flashing "Not connected" before the fetch completes.
  const [outlookStatus, setOutlookStatus] = useState<OutlookStatus | null>(null);
  const [status, setStatus] = useState<Record<ProviderKey, any>>({
    supabase: null, dataforseo: null, keepa: null, openai: null, apollo: null, outlook: null,
  });
  const [loading, setLoading] = useState<Record<ProviderKey, boolean>>({
    supabase: false, dataforseo: false, keepa: false, openai: false, apollo: false, outlook: false,
  });
  const [disconnecting, setDisconnecting] = useState(false);
  const [banner, setBanner] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  // On URL params from OAuth callback, surface a banner and clean the URL.
  useEffect(() => {
    if (msStatus === "connected") {
      setBanner({ type: "ok", text: "Outlook connected successfully." });
      router.replace("/app/settings");
    } else if (msStatus === "error") {
      setBanner({ type: "error", text: msError || "Outlook connection failed." });
      router.replace("/app/settings");
    }
  }, [msStatus, msError, router]);

  function loadStatus() {
    fetch("/api/providers/test").then(r => r.json()).then(d => {
      if (d?.configured) setConfigured(d.configured);
      if (d?.outlook) setOutlookStatus(d.outlook);
    });
  }

  useEffect(() => {
    loadStatus();
  }, []);

  async function test(provider: ProviderKey) {
    setLoading(l => ({ ...l, [provider]: true }));
    try {
      const r = await fetch("/api/providers/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const d = await r.json();
      setStatus(s => ({ ...s, [provider]: d }));
    } finally {
      setLoading(l => ({ ...l, [provider]: false }));
    }
  }

  async function disconnectOutlook() {
    if (!confirm("Disconnect Outlook? You'll need to reconnect before sending more drafts.")) return;
    setDisconnecting(true);
    try {
      await fetch("/api/auth/microsoft/disconnect", { method: "POST" });
      loadStatus();
      setBanner({ type: "ok", text: "Outlook disconnected." });
    } finally {
      setDisconnecting(false);
    }
  }

  const rows: { key: ProviderKey; name: string; desc: string }[] = [
    { key: "supabase", name: "Supabase", desc: "Auth, database, storage." },
    { key: "dataforseo", name: "DataForSEO", desc: "Amazon keyword volume + SERP / product data." },
    { key: "keepa", name: "Keepa", desc: "ASIN enrichment, BSR, price and review history." },
    { key: "openai", name: "OpenAI", desc: "Analyst memos, supplier scoring, contact ranking." },
    { key: "apollo", name: "Apollo.io", desc: "Find people at supplier companies; reveal verified emails on enrich." },
  ];

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <div className="mb-5">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">Connect your Outlook mailbox once — refresh tokens auto-renew. Below it, test each backend provider.</p>
      </div>

      {banner && (
        <div
          className={`mb-4 card p-3 text-sm flex items-start justify-between gap-3 ${banner.type === "ok" ? "border-[var(--green)]/40" : "border-[var(--red)]/40"}`}
        >
          <div className="flex items-start gap-2">
            {banner.type === "ok" ? (
              <Check size={16} className="text-[var(--green)] mt-0.5" />
            ) : (
              <X size={16} className="text-[var(--red)] mt-0.5" />
            )}
            <div>{banner.text}</div>
          </div>
          <button className="btn" onClick={() => setBanner(null)}>Dismiss</button>
        </div>
      )}

      {/* Outlook OAuth card */}
      <div className="card p-4 md:p-5 mb-5">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="rounded-md bg-[var(--surface-2)] p-2">
            <Mail size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-medium">Outlook mailbox</h2>
              {outlookStatus === null ? (
                <span className="pill" style={{ fontSize: 10 }}>Checking…</span>
              ) : outlookStatus.mode === "oauth" ? (
                <span className="pill pill-launch" style={{ fontSize: 10 }}>Connected</span>
              ) : outlookStatus.mode === "legacy_env" ? (
                <span className="pill pill-deep_dive" style={{ fontSize: 10 }}>Legacy token — expires hourly</span>
              ) : (
                <span className="pill pill-reject" style={{ fontSize: 10 }}>Not connected</span>
              )}
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1">
              Used to drop the 5-step outreach emails as drafts in your Outlook inbox. Connect once — we store an encrypted refresh token and renew access automatically.
            </div>
            {outlookStatus?.mode === "oauth" && outlookStatus.account_email && (
              <div className="text-sm mt-2">
                <span className="text-[var(--text-muted)]">Signed in as: </span>
                <span className="font-mono">{outlookStatus.account_email}</span>
              </div>
            )}
            {outlookStatus?.mode === "legacy_env" && (
              <div className="text-xs text-[var(--red)] mt-2">
                You’re running on a manually-pasted OUTLOOK_ACCESS_TOKEN that expires every ~60 minutes. Click <strong>Connect Outlook</strong> below to switch to the auto-refreshing OAuth flow.
              </div>
            )}
            {outlookStatus && !outlookStatus.oauth_app_configured && (
              <div className="text-xs text-[var(--red)] mt-2">
                MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET not set in Vercel — OAuth is unavailable.
              </div>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            {outlookStatus?.mode === "oauth" ? (
              <>
                <a className="btn" href="/api/auth/microsoft/start">
                  <RefreshCw size={14} /> Reconnect
                </a>
                <button
                  className="btn"
                  onClick={disconnectOutlook}
                  disabled={disconnecting}
                >
                  <LogOut size={14} /> Disconnect
                </button>
              </>
            ) : (
              <a className="btn btn-primary" href="/api/auth/microsoft/start">
                <ExternalLink size={14} /> Connect Outlook
              </a>
            )}
            <button className="btn" onClick={() => test("outlook")} disabled={loading.outlook}>
              <RefreshCw size={14} className={loading.outlook ? "animate-spin" : ""} />
              Test
            </button>
          </div>
        </div>
        {status.outlook && (
          <div className="mt-3 text-xs">
            {status.outlook.ok ? (
              <div className="flex items-center gap-1.5 text-[var(--green)]"><Check size={12} />
                {status.outlook.user_email ? `Mailbox reachable: ${status.outlook.user_email}` : "OK"}
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-[var(--red)]"><X size={12} /> {status.outlook.error ?? "Failed"}</div>
            )}
          </div>
        )}
      </div>

      <h2 className="text-sm font-medium tracking-tight text-[var(--text-muted)] mb-2">Backend providers</h2>
      <div className="card divide-y divide-[var(--border-soft)]">
        {rows.map(r => {
          const s = status[r.key];
          const ok = s?.ok;
          const isConfigured = configured[r.key];
          return (
            <div key={r.key} className="p-4 flex flex-wrap gap-3 items-center justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  {isConfigured
                    ? <span className="pill pill-launch" style={{ fontSize: 10 }}>Configured</span>
                    : <span className="pill pill-reject" style={{ fontSize: 10 }}>Missing</span>}
                </div>
                <div className="text-xs text-[var(--text-muted)] mt-0.5">{r.desc}</div>
                {s && (
                  <div className="mt-2 text-xs">
                    {ok ? (
                      <div className="flex items-center gap-1.5 text-[var(--green)]"><Check size={12} />
                        {r.key === "dataforseo" && s.money != null ? `Credits: $${s.money}` : null}
                        {r.key === "keepa" && s.tokens_left != null ? `Tokens: ${s.tokens_left}` : null}
                        {r.key === "openai" && s.models_count ? `${s.models_count} models available` : null}
                        {r.key === "supabase" && s.user_email ? `Signed in: ${s.user_email}` : null}
                        {r.key === "apollo" && "Search OK"}
                        {!s.money && !s.tokens_left && !s.models_count && !s.user_email && r.key !== "apollo" && "OK"}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-[var(--red)]"><X size={12} /> {s.error ?? "Failed"}</div>
                    )}
                  </div>
                )}
              </div>
              <button className="btn" onClick={() => test(r.key)} disabled={loading[r.key]}>
                <RefreshCw size={14} className={loading[r.key] ? "animate-spin" : ""} />
                Test
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-5 card p-4 text-xs text-[var(--text-muted)] leading-relaxed">
        <strong className="text-[var(--text)]">Env vars expected (set in Vercel):</strong>
        <ul className="mt-2 space-y-1 font-mono">
          <li>NEXT_PUBLIC_SUPABASE_URL</li>
          <li>NEXT_PUBLIC_SUPABASE_ANON_KEY</li>
          <li>SUPABASE_SERVICE_ROLE_KEY</li>
          <li>DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD</li>
          <li>KEEPA_API_KEY, KEEPA_DOMAIN_ID</li>
          <li>OPENAI_API_KEY</li>
          <li>APOLLO_API_KEY</li>
          <li>MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET <span className="not-italic">(for Outlook OAuth)</span></li>
          <li>MICROSOFT_TENANT_ID <span className="not-italic">(optional — defaults to "common")</span></li>
        </ul>
      </div>
    </div>
  );
}
