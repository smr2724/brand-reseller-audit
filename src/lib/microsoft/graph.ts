/**
 * Phase 6.5 — Microsoft Graph client (drafts only).
 *
 * Creates drafts in the signed-in user's Outlook mailbox. We never call
 * `/me/sendMail` — the user always sends from Outlook themselves. If the
 * stored access token is rejected as expired/invalid, callers receive a
 * structured `{ reauthRequired: true }` flag so the UI can surface a
 * "Reconnect Outlook" link.
 */
import { loadUserGraphToken } from "@/lib/microsoft/tokens";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface DraftRecipient {
  address: string;
  name?: string;
}

export interface CreateDraftInput {
  userId: string;
  to: DraftRecipient;
  subject: string;
  html: string;
  text?: string; // Used as a plain-text fallback in logs. Graph itself only stores one body.
}

export interface CreateDraftSuccess {
  ok: true;
  messageId: string;
  webLink: string;
}

export interface CreateDraftFailure {
  ok: false;
  error: string;
  reauthRequired?: boolean;
  status?: number;
}

export type CreateDraftResult = CreateDraftSuccess | CreateDraftFailure;

function isAuthError(status: number, body: string): boolean {
  return (
    status === 401 ||
    /InvalidAuthenticationToken|expired|lifetime|TokenExpired/i.test(body)
  );
}

export async function createDraft(input: CreateDraftInput): Promise<CreateDraftResult> {
  const tok = await loadUserGraphToken(input.userId);
  if (!tok?.accessToken) {
    return {
      ok: false,
      error:
        'Outlook is not connected. Click "Connect Outlook" on the Settings page to authorize.',
      reauthRequired: true,
    };
  }

  const payload = {
    subject: input.subject,
    body: {
      contentType: "HTML",
      content: input.html,
    },
    toRecipients: [
      {
        emailAddress: {
          address: input.to.address,
          ...(input.to.name ? { name: input.to.name } : {}),
        },
      },
    ],
    isDraft: true,
  };

  let resp: Response;
  try {
    resp = await fetch(`${GRAPH_BASE}/me/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tok.accessToken}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, error: `Network error talking to Microsoft Graph: ${String((e as Error)?.message ?? e)}` };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (isAuthError(resp.status, text)) {
      return {
        ok: false,
        status: resp.status,
        reauthRequired: true,
        error:
          'Outlook authorization expired. Click "Reconnect Outlook" to refresh your connection.',
      };
    }
    return {
      ok: false,
      status: resp.status,
      error: `Graph ${resp.status}: ${text.slice(0, 300)}`,
    };
  }

  let data: { id?: string; webLink?: string };
  try {
    data = (await resp.json()) as { id?: string; webLink?: string };
  } catch (e) {
    return { ok: false, error: `Invalid JSON from Graph: ${String((e as Error)?.message ?? e)}` };
  }
  if (!data?.id) {
    return { ok: false, error: "Graph did not return a draft id" };
  }
  return {
    ok: true,
    messageId: data.id,
    webLink: data.webLink ?? "",
  };
}

/**
 * Lightweight "is this token still good?" probe. Returns the connected
 * account's email when the token works, otherwise null. Used by the
 * health-check route.
 */
export async function probeMe(userId: string): Promise<{ email: string | null } | null> {
  const tok = await loadUserGraphToken(userId);
  if (!tok?.accessToken) return null;
  try {
    const r = await fetch(`${GRAPH_BASE}/me`, {
      headers: { Authorization: `Bearer ${tok.accessToken}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return { email: d.mail ?? d.userPrincipalName ?? null };
  } catch {
    return null;
  }
}
