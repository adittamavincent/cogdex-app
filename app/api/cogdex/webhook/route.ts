import { NextResponse, type NextRequest } from "next/server";
import type { CogdexWebhookPayload, PageType, WebhookAction } from "@/lib/types";
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Parse payload body ---
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let action: WebhookAction;
  let thoughtId: string;
  let pageType: PageType | undefined;
  let continueBranch = false;

  // Detect payload format via the "x-cogdex-page-type" header (legacy automated format)
  const pageTypeHeader = req.headers.get("x-cogdex-page-type");

  if (pageTypeHeader) {
    // --- Legacy / Automated Payload Format ---
    if (!VALID_PAGE_TYPES.includes(pageTypeHeader as PageType)) {
      return NextResponse.json(
        {
          error: `Invalid x-cogdex-page-type header. Must be one of: ${VALID_PAGE_TYPES.join(", ")}`,
        },
        { status: 400 }
      );
    }
    pageType = pageTypeHeader as PageType;
    action = pageType === "Compile" ? "compile" : "create";
    thoughtId = body?.data?.id;
    continueBranch = false;
  } else {
    // --- New Custom Payload Format (CogdexWebhookPayload) ---
    const payload = body as CogdexWebhookPayload;
    action = payload.action;
    thoughtId = payload.thoughtId;
    pageType = payload.pageType;
    continueBranch = payload.continueBranch ?? false;
  }

  if (!thoughtId) {
    return NextResponse.json(
      { error: "Could not extract page ID (thoughtId)" },
      { status: 400 }
    );
  }

  // --- Route to action ---
  try {
    if (action === "compile") {
      await compileAndCreate(thoughtId);
      return NextResponse.json({ ok: true });
    }

    if (action === "create") {
      if (!pageType) {
        return NextResponse.json({ error: "Missing pageType" }, { status: 400 });
      }
      const pageId = await createEntry({
        thoughtId,
        pageType,
        continueBranch,
      });
      return NextResponse.json({ ok: true, pageId });
    }

    return NextResponse.json({ error: `Invalid action: ${action}` }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    console.error("[Cogdex] Webhook error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

