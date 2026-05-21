import type { NextRequest } from "next/server";
import type { PageType } from "@/lib/types";
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
  // --- Read raw body first (for logging and resilient parsing) ---
  const rawBody = await req.text();

  // Log the full incoming request so we can see exactly what Notion sends
  console.log("[Cogdex] Incoming webhook", {
    headers: Object.fromEntries(req.headers.entries()),
    rawBody,
  });

  // --- Auth ---
  const incomingSecret = req.headers.get("x-cogdex-secret");
  if (incomingSecret !== SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Page type (from header — differs per button) ---
  const pageTypeHeader = req.headers.get("x-cogdex-page-type");
  if (!pageTypeHeader || !VALID_PAGE_TYPES.includes(pageTypeHeader as PageType)) {
    return Response.json(
      {
        error: `Invalid or missing x-cogdex-page-type header. Must be one of: ${VALID_PAGE_TYPES.join(", ")}`,
      },
      { status: 400 }
    );
  }
  const pageType = pageTypeHeader as PageType;

  // --- Parse body (Notion may send empty body, JSON, or its own native format) ---
  let parsed: Record<string, unknown> = {};
  if (rawBody) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      // body exists but isn't valid JSON — log it and continue;
      // thoughtId will be missing and we'll return a helpful error below
      console.warn("[Cogdex] Body is not valid JSON:", rawBody);
    }
  }

  // --- Extract thoughtId ---
  // Try our custom field first, then fall back to Notion's native page ID field
  const thoughtId =
    (parsed.thoughtId as string | undefined) ||
    (parsed.id as string | undefined);

  if (!thoughtId) {
    return Response.json(
      {
        error: "Could not determine thoughtId",
        hint: "Configure the webhook body in Notion to include the current page ID. Check Vercel function logs to see what Notion is sending.",
        received_body: rawBody || "(empty)",
      },
      { status: 400 }
    );
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
    console.error("[Cogdex] Webhook error:", err);
    return Response.json({ error: message }, { status: 500 });
  }
}
