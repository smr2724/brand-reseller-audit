"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Zap, Layers } from "lucide-react";

const PRESETS: { label: string; keywords: string[] }[] = [
  { label: "Pest & Wildlife Control", keywords: ["mole repellent", "vole killer", "carpenter bee trap", "wasp killer foam", "snake repellent", "gopher gas", "mouse bait station"] },
  { label: "Auto Detailing & Restoration", keywords: ["headlight restoration kit", "tar remover", "brake dust cleaner", "leather restorer", "paint overspray remover", "wheel cleaner", "clay bar kit"] },
  { label: "Pool, Spa & Water", keywords: ["pool stain remover", "calcium remover for pool", "phosphate remover", "spa flush", "well water iron filter", "pool clarifier"] },
  { label: "HVAC & Appliance Maintenance", keywords: ["dishwasher descaler", "ac coil cleaner", "dryer vent cleaning kit", "washing machine cleaner", "garbage disposal cleaner", "humidifier cleaner"] },
  { label: "Lawn, Garden & Turf Pro", keywords: ["stump remover", "crabgrass killer", "lawn fungicide", "root killer for sewer line", "dethatcher rake", "grub killer"] },
  { label: "Pet Odor, Stain & Utility", keywords: ["cat urine enzyme cleaner", "dog ear cleaner", "skunk odor remover", "pet hair remover for laundry", "flea treatment for yard"] },
  { label: "Tools & Hardware Specialty", keywords: ["stripped screw extractor", "broken bolt remover", "drain snake auger", "magnetic parts tray", "thread repair kit", "impact driver bit set"] },
  { label: "Marine, RV & Off-Grid", keywords: ["rv holding tank treatment", "bilge cleaner", "rv antifreeze", "generator stabilizer", "anti fouling paint", "rv roof cleaner"] },
  { label: "Concrete / Masonry", keywords: ["concrete remover", "oil stain remover for concrete", "grout haze remover", "rust remover for concrete", "efflorescence remover"] },
  { label: "Specialty Removers", keywords: ["graffiti remover", "adhesive remover", "rust remover", "paint remover", "mold stain remover"] },
  { label: "Industrial / Janitorial", keywords: ["industrial degreaser", "floor stripper", "commercial descaler", "equipment cleaner", "no rinse disinfectant"] },
  { label: "Commercial Kitchen", keywords: ["commercial kitchen degreaser", "oven cleaner commercial", "grill cleaner", "fryer boil out"] },
];

export default function BatchScanPage() {
  const router = useRouter();
  const [seedsRaw, setSeedsRaw] = useState("");
  const [name, setName] = useState("");
  const [depth, setDepth] = useState<"quick" | "standard" | "deep">("standard");
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const seeds = seedsRaw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);

  function addPreset(p: { label: string; keywords: string[] }) {
    const existing = new Set(seeds.map(s => s.toLowerCase()));
    const next = [...seeds];
    for (const k of p.keywords) if (!existing.has(k.toLowerCase())) next.push(k);
    setSeedsRaw(next.join("\n"));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!seeds.length) { setErr("Add at least one seed keyword"); return; }
    if (seeds.length > 50) { setErr("Max 50 seeds per sweep"); return; }
    setRunning(true);
    try {
      const res = await fetch("/api/sweeps/create", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seeds, depth, name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed");
      router.push(`/app/sweeps/${data.sweep_id}`);
    } catch (e: any) {
      setErr(e?.message ?? "Failed");
      setRunning(false);
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <div className="mb-5">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Layers size={20} /> Batch Scan
        </h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Paste many seed keywords or pick preset groups. Each seed runs as a separate scan in parallel — watch live progress on the sweep page.
        </p>
      </div>

      <form onSubmit={submit} className="card p-4 md:p-6 space-y-4">
        <div>
          <label className="label">Sweep name (optional)</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Pool & Spa sweep #3" />
        </div>

        <div>
          <label className="label">Seed keywords <span className="text-[var(--text-muted)] font-normal">({seeds.length} {seeds.length === 1 ? "keyword" : "keywords"})</span></label>
          <textarea
            className="input font-mono text-sm"
            rows={10}
            value={seedsRaw}
            onChange={e => setSeedsRaw(e.target.value)}
            placeholder={"One per line. Examples:\nconcrete remover\nrust remover\ngraffiti remover"}
          />
          <p className="text-[11px] text-[var(--text-muted)] mt-1">Max 50 per sweep. Duplicates are removed automatically.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="label">Scan depth</label>
            <select className="select" value={depth} onChange={e => setDepth(e.target.value as any)}>
              <option value="quick">Quick (top 10) — fastest</option>
              <option value="standard">Standard (top 20)</option>
              <option value="deep">Deep (top 40) — slower</option>
            </select>
          </div>
        </div>

        {err && <div className="text-xs text-[var(--red)] p-2 rounded-md bg-[rgba(248,113,113,0.08)] border border-[rgba(248,113,113,0.2)]">{err}</div>}

        <div className="flex items-center gap-2">
          <button className="btn btn-primary" disabled={running || !seeds.length}>
            {running ? (<><Zap size={16} /> Starting…</>) : (<><Zap size={16} /> Run sweep ({seeds.length})</>)}
          </button>
          <span className="text-xs text-[var(--text-muted)]">Up to 4 scans run in parallel. ~1–2 min per seed.</span>
        </div>
      </form>

      <div className="mt-6">
        <h2 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">Preset seed groups (click to add)</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {PRESETS.map(p => (
            <div key={p.label} className="card p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium text-sm">{p.label}</div>
                <button type="button" onClick={() => addPreset(p)} className="btn btn-ghost text-[10px] px-2 py-1">+ Add all {p.keywords.length}</button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {p.keywords.map(k => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      const existing = new Set(seeds.map(s => s.toLowerCase()));
                      if (existing.has(k.toLowerCase())) return;
                      setSeedsRaw([...seeds, k].join("\n"));
                    }}
                    className="pill pill-new"
                    style={{ cursor: "pointer", textTransform: "none", letterSpacing: 0 }}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
