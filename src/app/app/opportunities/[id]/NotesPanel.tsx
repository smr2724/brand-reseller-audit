"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatDateTime } from "@/lib/utils";

export default function NotesPanel({ opportunityId, initialNotes }: { opportunityId: string; initialNotes: any[] }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notes, setNotes] = useState(initialNotes);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setSubmitting(true);
    try {
      await fetch(`/api/opportunities/${opportunityId}/notes`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: body.trim() }),
      });
      setNotes([{ id: Math.random().toString(36), body: body.trim(), created_at: new Date().toISOString() }, ...notes]);
      setBody("");
      router.refresh();
    } finally { setSubmitting(false); }
  }

  return (
    <div>
      <form onSubmit={submit} className="mb-3 flex gap-2">
        <input className="input flex-1" placeholder="Add note…" value={body} onChange={e => setBody(e.target.value)} />
        <button className="btn btn-primary" disabled={submitting}>Add</button>
      </form>
      <div className="space-y-2">
        {notes.map(n => (
          <div key={n.id} className="card-soft p-2.5">
            <div className="text-sm whitespace-pre-wrap">{n.body}</div>
            <div className="text-[11px] text-[var(--text-muted)] mt-1">{formatDateTime(n.created_at)}</div>
          </div>
        ))}
        {!notes.length && <div className="text-xs text-[var(--text-muted)]">No notes yet.</div>}
      </div>
    </div>
  );
}
