import type { NextRequest } from "next/server";
import type { CogdexWebhookPayload, PageType } from "@/lib/types";
import { createEntry } from "@/lib/entries";
import { compileAndCreate } from "@/lib/compile";

// Force Node.js runtime (required for Notion SDK and long-running compile jobs)
export const runtime = "nodejs";

const SECRET = process.env.COGDEX_WEBHOOK_SECRET!;

const VALID_PAGE_TYPES: PageType[] = [
  "User",
  "Response",
  "Agreement",
  "Checkpoint",
  "Attachment",
  "Compile",
];

export async function POST(req: NextRequest) {
  // --- Auth ---
  const incomingSecret = req.headers.get("x-cogdex-secret");
  if (incomingSecret !== SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Page type (from header — differs per button, set by the automation) ---
  const pageTypeHeader = req.headers.get("x-cogdex-page-type");
  if (!pageTypeHeader || !VALID_PAGE_TYPES.includes(pageTypeHeader as PageType)) {
    return Response.json(
      { error: `Invalid or missing x-cogdex-page-type header. Must be one of: ${VALID_PAGE_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  const pageType = pageTypeHeader as PageType;

  // --- Body (Notion content variables — carries the current Thought Management page ID) ---
  let body: CogdexWebhookPayload;
  try {
    body = (await req.json()) as CogdexWebhookPayload;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { thoughtId } = body;
  if (!thoughtId) {
    return Response.json({ error: "Missing thoughtId in body" }, { status: 400 });
  }

  // --- Route to action ---
  try {
    if (pageType === "Compile") {
      await compileAndCreate(thoughtId);
      return Response.json({ ok: true });
    }

    const pageId = await createEntry({ thoughtId, pageType });
    return Response.json({ ok: true, pageId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("Cogdex webhook error:", err);
    return Response.json({ error: message }, { status: 500 });
  }
}
