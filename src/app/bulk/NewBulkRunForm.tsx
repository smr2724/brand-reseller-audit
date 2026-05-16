"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function NewBulkRunForm() {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!raw.trim()) {
      setError("Paste at least one brand name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bulk/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_input: raw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `Start failed (HTTP ${res.status})`);
        setBusy(false);
        return;
      }
      router.push(`/bulk/${data.run_id}`);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{
        background: "#fff",
        border: "1px solid #e5e1d8",
        borderRadius: 4,
        padding: 20,
      }}
    >
      <label
        htmlFor="bulk-input"
        style={{
          display: "block",
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: 0.04,
          color: "#666",
          marginBottom: 6,
        }}
      >
        Brand list
      </label>
      <textarea
        id="bulk-input"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={10}
        placeholder={`Paste brand names — one per line, or separated by commas / semicolons / tabs.
e.g.
Yeti
OXO
World Amenities, Carna4; Sport-Tek`}
        style={{
          width: "100%",
          padding: 12,
          fontSize: 14,
          fontFamily: "inherit",
          border: "1px solid #d8d2c4",
          borderRadius: 3,
          resize: "vertical",
          minHeight: 180,
        }}
        disabled={busy}
      />
      {error ? (
        <p style={{ color: "#a02020", fontSize: 13, margin: "10px 0 0" }}>{error}</p>
      ) : null}
      <div
        style={{
          marginTop: 14,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <p style={{ color: "#888", fontSize: 12, margin: 0 }}>
          Up to 100 brands per run. Drafts auto-create for every qualified +
          verified brand.
        </p>
        <button
          type="submit"
          disabled={busy}
          style={{
            background: busy ? "#999" : "#1a1a1a",
            color: "#fff",
            border: 0,
            padding: "10px 22px",
            fontSize: 13,
            letterSpacing: 0.04,
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "Starting…" : "Start bulk run"}
        </button>
      </div>
    </form>
  );
}
