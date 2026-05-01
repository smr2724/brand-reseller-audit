/**
 * Microsoft Outlook draft creation via Microsoft Graph.
 *
 * Auth strategy (in order of preference):
 *   1. Per-user OAuth via the `oauth_tokens` table — refresh tokens auto-renew
 *      indefinitely as long as the user keeps using the app at least every 90 days.
 *      Set up via the "Connect Outlook" button on /app/settings.
 *   2. Legacy `OUTLOOK_ACCESS_TOKEN` env var — still honored as a fallback for
 *      the original v1 setup. Tokens expire in ~60–90 minutes.
 *
 * If neither is configured, the API returns a clear error that tells Steve to
 * click Connect Outlook. There is intentionally NO mailto fallback (that opens
 * macOS Mail.app on desktops).
 */
import { getValidOutlookToken } from "@/lib/microsoft-oauth";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface CreateDraftInput {
  userId: string;
  toEmail: string;
  toName?: string;
  subject: string;
  body: string;        // plain text or simple HTML
}

export interface CreateDraftResult {
  ok: boolean;
  outlookDraftId?: string;
  webLink?: string;
  error?: string;
}

async function resolveAccessToken(userId: string): Promise<string | null> {
  // Prefer per-user OAuth.
  const oauth = await getValidOutlookToken(userId);
  if (oauth?.accessToken) return oauth.accessToken;
  // Fallback to legacy env var.
  return process.env.OUTLOOK_ACCESS_TOKEN || null;
}

export async function createOutlookDraft(input: CreateDraftInput): Promise<CreateDraftResult> {
  const token = await resolveAccessToken(input.userId);
  if (!token) {
    return {
      ok: false,
      error:
        "Outlook is not connected. Click \"Connect Outlook\" on the Settings page to authorize.",
    };
  }

  const payload = {
    subject: input.subject,
    body: {
      contentType: "Text",
      content: input.body,
    },
    toRecipients: [
      {
        emailAddress: {
          address: input.toEmail,
          ...(input.toName ? { name: input.toName } : {}),
        },
      },
    ],
    isDraft: true,
  };

  try {
    const r = await fetch(`${GRAPH_BASE}/me/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const text = await r.text();
      const expired = r.status === 401 || /InvalidAuthenticationToken|expired|lifetime/i.test(text);
      return {
        ok: false,
        error: expired
          ? "Outlook authorization expired. Click \"Connect Outlook\" on the Settings page to reconnect."
          : `Graph ${r.status}: ${text.slice(0, 200)}`,
      };
    }
    const data = await r.json();
    return {
      ok: true,
      outlookDraftId: data.id,
      webLink: data.webLink,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function testOutlook(
  userId: string,
): Promise<{ ok: boolean; error?: string; user_email?: string }> {
  const token = await resolveAccessToken(userId);
  if (!token) return { ok: false, error: "Outlook not connected" };
  try {
    const r = await fetch(`${GRAPH_BASE}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { ok: false, error: `Graph ${r.status}` };
    const d = await r.json();
    return { ok: true, user_email: d.mail ?? d.userPrincipalName };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
