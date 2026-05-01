"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

interface Props {
  initial: {
    q?: string;
    geo?: string;
    path?: string;
    amazon?: string;
    channel?: string;
    min?: string;
    archived?: string;
  };
  archivedCount?: number;
  showArchived?: boolean;
}

export default function SuppliersFilters({ initial, archivedCount, showArchived }: Props) {
  const router = useRouter();
  const sp = useSearchParams();
  const [, startTransition] = useTransition();

  const [q, setQ] = useState(initial.q ?? "");
  const [geo, setGeo] = useState(initial.geo ?? "");
  const [path, setPath] = useState(initial.path ?? "");
  const [amazon, setAmazon] = useState(initial.amazon ?? "");
  const [channel, setChannel] = useState(initial.channel ?? "");
  const [min, setMin] = useState(initial.min ?? "0");

  function apply() {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (geo) next.set("geo", geo);
    if (path) next.set("path", path);
    if (amazon) next.set("amazon", amazon);
    if (channel) next.set("channel", channel);
    if (min && min !== "0") next.set("min", min);
    if (showArchived) next.set("archived", "1");
    startTransition(() => router.push(`/app/suppliers?${next.toString()}`));
  }

  function reset() {
    setQ(""); setGeo(""); setPath(""); setAmazon(""); setChannel(""); setMin("0");
    const next = showArchived ? "?archived=1" : "";
    startTransition(() => router.push(`/suppliers${next}`));
  }

  function toggleArchived() {
    const next = new URLSearchParams(sp.toString());
    if (showArchived) next.delete("archived"); else next.set("archived", "1");
    startTransition(() => router.push(`/app/suppliers?${next.toString()}`));
  }

  return (
    <div className="card p-3 mb-4">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <input
          className="input"
          placeholder="Search company or domain"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.key === "Enter" && apply()}
        />
        <select className="input" value={geo} onChange={e => setGeo(e.target.value)}>
          <option value="">All geo tiers</option>
          <option value="T1_NV_adjacent">T1 · NV adjacent</option>
          <option value="T2_west_us">T2 · West US</option>
          <option value="T3_rest_us">T3 · Rest US</option>
          <option value="T4_mexico">T4 · Mexico</option>
          <option value="T5_intl">T5 · International</option>
          <option value="unknown">Unknown</option>
        </select>
        <select className="input" value={path} onChange={e => setPath(e.target.value)}>
          <option value="">All paths</option>
          <option value="partner">Partner</option>
          <option value="private_label">Private label</option>
          <option value="wholesale_resell">Wholesale resell</option>
          <option value="skip">Skip</option>
        </select>
        <select className="input" value={amazon} onChange={e => setAmazon(e.target.value)}>
          <option value="">Amazon: any</option>
          <option value="no">Not on Amazon</option>
          <option value="yes">Selling on Amazon</option>
        </select>
        <select className="input" value={channel} onChange={e => setChannel(e.target.value)}>
          <option value="">Any channel</option>
          <option value="manufacturer_b2b">Manufacturer (B2B)</option>
          <option value="manufacturer_dtc">Manufacturer (DTC)</option>
          <option value="distributor">Distributor</option>
          <option value="retailer">Retailer</option>
        </select>
        <select className="input" value={min} onChange={e => setMin(e.target.value)}>
          <option value="0">Any score</option>
          <option value="50">Score 50+</option>
          <option value="60">Score 60+</option>
          <option value="70">Score 70+</option>
          <option value="80">Score 80+</option>
        </select>
      </div>
      <div className="flex gap-2 mt-2 items-center">
        <button className="btn btn-primary" onClick={apply}>Apply filters</button>
        <button className="btn btn-ghost" onClick={reset}>Reset</button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={toggleArchived}
          className={`btn text-xs ${showArchived ? "btn-primary" : ""}`}
          title={showArchived ? "Back to active" : "View archived suppliers"}
        >
          {showArchived
            ? "← Show active"
            : `Show archived${archivedCount ? ` (${archivedCount})` : ""}`}
        </button>
      </div>
    </div>
  );
}
