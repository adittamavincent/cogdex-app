import type { NextRequest } from "next/server";
import type { CogdexWebhookPayload } from "@/lib/types";
import { createEntry } from "@/lib/entries";
import { compileAndCreate } from "@/lib/compile";

// Force Node.js runtime (required for Notion SDK and long-running compile jobs)
export const runtime = "nodejs";

const SECRET = process.env.COGDEX_WEBHOOK_SECRET!;

export async function POST(req: NextRequest) {
  // Verify custom secret header
  const incomingSecret = req.headers.get("x-cogdex-secret");
  if (incomingSecret !== SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CogdexWebhookPayload;
  try {
    body = (await req.json()) as CogdexWebhookPayload;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { action, thoughtId, pageType } = body;

  if (!action || !thoughtId) {
    return Response.json(
      { error: "Missing action or thoughtId" },
      { status: 400 }
    );
  }

  try {
    if (action === "create") {
      if (!pageType) {
        return Response.json({ error: "Missing pageType" }, { status: 400 });
      }
      const pageId = await createEntry({ thoughtId, pageType });
      return Response.json({ ok: true, pageId });
    }

    if (action === "compile") {
      await compileAndCreate(thoughtId);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("Cogdex webhook error:", err);
    return Response.json({ error: message }, { status: 500 });
  }
}
