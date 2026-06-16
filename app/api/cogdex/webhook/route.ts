import type { NextRequest } from "next/server";
import type { NotionAutomationPayload, PageType } from "@/lib/types";
import { notion } from "@/lib/notion";
import { createEntry, relinkDatabases, handleCanvasUpdate, handleUserComment, handleCNVUPD, resolveDataSourceId, setExclusiveInclude, markdownToRichNotionBlocks } from "@/lib/entries";
import { exportAndCreate } from "@/lib/export";
import { error as logError } from "@/lib/logger";

// Force Node.js runtime (required for Notion SDK and long-running compile jobs)
export const runtime = "nodejs";

const SECRET = process.env.COGDEX_WEBHOOK_SECRET!;
const SECRET_HEADER = process.env.COGDEX_SECRET_HEADER || "x-cogdex-secret";
const PAGE_TYPE_HEADER = process.env.COGDEX_PAGE_TYPE_HEADER || "x-cogdex-page-type";

const VALID_PAGE_TYPES: PageType[] = [
  "CHAT USER",
  "CHAT RESP",
  "MEMO EXPO",
  "MEMO RESP",
  "CHAT EXPO",
  "CHAT CMNT",
  "SYST LINK",
  "MEMO UPDT",
  "REPO SNAP",
];

export async function POST(req: NextRequest) {
  // --- Auth ---
  const incomingSecret =
    req.headers.get(SECRET_HEADER) ||
    req.headers.get("cogdex-secret") ||
    req.headers.get("x-cogdex-secret") ||
    req.headers.get("authorization")?.replace("Bearer ", "");

  if (!SECRET || incomingSecret !== SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Page type (from header — the only thing that differs per button) ---
  const pageTypeHeader =
    req.headers.get(PAGE_TYPE_HEADER) ||
    req.headers.get("cogdex-page-type") ||
    req.headers.get("x-cogdex-page-type");

  if (!pageTypeHeader || !VALID_PAGE_TYPES.includes(pageTypeHeader as PageType)) {
    return Response.json(
      {
        error: `Invalid or missing page type header. Must be one of: ${VALID_PAGE_TYPES.join(", ")}`,
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
    if (pageType === "CHAT EXPO") {
      await exportAndCreate(thoughtId, false);
      return Response.json({ ok: true });
    }

    if (pageType === "MEMO EXPO") {
      await exportAndCreate(thoughtId, true);
      return Response.json({ ok: true });
    }

    if (pageType === "SYST LINK") {
      await relinkDatabases(thoughtId);
      return Response.json({ ok: true });
    }

    if (pageType === "MEMO RESP") {
      const pageObj = await notion.pages.retrieve({ page_id: thoughtId }) as any;
      const parentId = pageObj?.parent?.database_id || pageObj?.parent?.data_source_id;
      const entryDbIdResolved = await resolveDataSourceId(process.env.NOTION_ENTRY_DB_ID || process.env.NOTION_ENTRIES_DB_ID!);

      if (parentId === entryDbIdResolved) {
        await handleCanvasUpdate(thoughtId);
        return Response.json({ ok: true });
      } else {
        const result = await createEntry({ thoughtId, pageType: "MEMO RESP" });
        return Response.json({ ok: true, ...result });
      }
    }

    if (pageType === "MEMO UPDT") {
      await handleCNVUPD(thoughtId);
      return Response.json({ ok: true });
    }

    if (pageType === "CHAT CMNT") {
      await handleUserComment(thoughtId);
      return Response.json({ ok: true });
    }

    if (pageType === "REPO SNAP") {
      const pageObj = await notion.pages.retrieve({ page_id: thoughtId }) as any;
      const canvasRelations = pageObj.properties?.Canvas?.relation || [];
      if (canvasRelations.length === 0) {
        return Response.json({ error: "No Canvas entry linked to this project" }, { status: 400 });
      }
      
      const canvasId = canvasRelations[0].id;
      const canvasPage = await notion.pages.retrieve({ page_id: canvasId }) as any;
      
      const repoUrlProp = canvasPage.properties?.["Repo URL"] || Object.values(canvasPage.properties || {}).find((p: any) => p.id === "ySdk");
      const repoUrl = repoUrlProp?.rich_text?.[0]?.plain_text;
      
      if (!repoUrl) {
        return Response.json({ error: "No Repo URL set on Canvas entry for this project" }, { status: 400 });
      }

      // Repomix packing with timeout
      const repomixPromise = async () => {
        const { runCli } = await import("repomix");
        const fs = await import("fs/promises");
        const path = await import("path");
        const os = await import("os");
        const crypto = await import("crypto");
        
        const tempFile = path.join(os.tmpdir(), `repomix-${crypto.randomUUID()}.txt`);
        
        try {
          // Vercel sometimes has issues with Tree-sitter WASM modules in Next.js Serverless functions
          // If it fails with compression, we fallback to non-compressed.
          await runCli([], process.cwd(), {
            remote: repoUrl,
            compress: true,
            output: tempFile
          });
        } catch (err: any) {
          logError("Repomix with compress failed, falling back without compress:", err);
          await runCli([], process.cwd(), {
            remote: repoUrl,
            compress: false,
            output: tempFile
          });
        }
        
        const content = await fs.readFile(tempFile, "utf-8");
        await fs.unlink(tempFile).catch(() => {});
        return content;
      };

      const timeoutPromise = new Promise<string>((_, reject) => 
        setTimeout(() => reject(new Error("Repomix timed out — try a smaller repo or scope with --include")), 45000)
      );

      let repomixOutput: string;
      try {
        repomixOutput = await Promise.race([repomixPromise(), timeoutPromise]);
      } catch (err: any) {
        if (err.message.includes("timed out")) {
          return Response.json({ error: err.message }, { status: 504 });
        }
        throw err;
      }

      const { pageId } = await createEntry({ thoughtId, pageType: "REPO SNAP" });
      if (pageId) {
        await setExclusiveInclude(thoughtId, "REPO SNAP", pageId);

        // write output in chunks
        const blocks = markdownToRichNotionBlocks(repomixOutput);
        const CHUNK = 100;
        for (let i = 0; i < blocks.length; i += CHUNK) {
          await notion.blocks.children.append({
            block_id: pageId,
            children: blocks.slice(i, i + CHUNK) as any,
          });
        }
      }

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


