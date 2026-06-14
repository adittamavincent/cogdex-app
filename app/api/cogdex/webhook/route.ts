import type { NextRequest } from "next/server";
import type { NotionAutomationPayload, PageType } from "@/lib/types";
import { createEntry, relinkDatabases, handleCanvasUpdate, handleUserComment, handleCNVUPD } from "@/lib/entries";
import { exportAndCreate } from "@/lib/export";
import { error as logError } from "@/lib/logger";

// Force Node.js runtime (required for Notion SDK and long-running compile jobs)
export const runtime = "nodejs";

const SECRET = process.env.COGDEX_WEBHOOK_SECRET!;
const SECRET_HEADER = process.env.COGDEX_SECRET_HEADER || "x-cogdex-secret";
const PAGE_TYPE_HEADER = process.env.COGDEX_PAGE_TYPE_HEADER || "x-cogdex-page-type";

const VALID_PAGE_TYPES: PageType[] = [
  "REG USR",
  "REG RES",
  "CNV EXP",
  "CNV RES",
  "REG EXP",
  "REG USR CMT",
  "Relink Databases",
  "CNV UPD",
];

export async function POST(req: NextRequest) {
  // --- Auth ---
  const incomingSecret =
    req.headers.get(SECRET_HEADER) ||
    req.headers.get("authorization")?.replace("Bearer ", "");

  if (!SECRET || incomingSecret !== SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Page type (from header — the only thing that differs per button) ---
  const pageTypeHeader = req.headers.get(PAGE_TYPE_HEADER);
  if (!pageTypeHeader || !VALID_PAGE_TYPES.includes(pageTypeHeader as PageType)) {
    return Response.json(
      {
        error: `Invalid or missing ${PAGE_TYPE_HEADER} header. Must be one of: ${VALID_PAGE_TYPES.join(", ")}`,
      },
      { status: 400 }
    );
  }
  const pageType = pageTypeHeader as PageType;

  // --- Parse Notion's automation payload ---
  // Notion always sends: { source: {...}, data: { id: "<page_id>", ... } }
  // data.id is the Thought Management row that triggered the button.
  // No user body configuration is needed — Notion sends this automatically.
  let payload: NotionAutomationPayload;
  try {
    payload = (await req.json()) as NotionAutomationPayload;
    const headersObj: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headersObj[k] = v;
    });
    console.log("Received Notion webhook headers:", JSON.stringify(headersObj, null, 2));
    console.log("Received Notion webhook payload:", JSON.stringify(payload, null, 2));
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const thoughtId = payload?.data?.id;
  if (!thoughtId) {
    logError("Could not extract thoughtId from payload:", payload);
    return Response.json(
      { error: "Could not extract page ID from Notion payload (expected data.id)" },
      { status: 400 }
    );
  }

  // --- Route to action ---
  try {
    if (pageType === "REG EXP") {
      await exportAndCreate(thoughtId, false);
      return Response.json({ ok: true });
    }

    if (pageType === "CNV EXP") {
      await exportAndCreate(thoughtId, true);
      return Response.json({ ok: true });
    }

    if (pageType === "Relink Databases") {
      await relinkDatabases(thoughtId);
      return Response.json({ ok: true });
    }

    if (pageType === "CNV RES") {
      await handleCanvasUpdate(thoughtId);
      return Response.json({ ok: true });
    }

    if (pageType === "CNV UPD") {
      await handleCNVUPD(thoughtId);
      return Response.json({ ok: true });
    }

    if (pageType === "REG USR CMT") {
      await handleUserComment(thoughtId);
      return Response.json({ ok: true });
    }

    const result = await createEntry({ thoughtId, pageType });
    return Response.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    logError("Webhook error:", err);
    return Response.json({ error: message }, { status: 500 });
  }
}


