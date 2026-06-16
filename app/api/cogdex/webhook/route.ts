import type { NextRequest } from "next/server";
import type { NotionAutomationPayload, PageType } from "@/lib/types";
import { notion } from "@/lib/notion";
import { createEntry, relinkDatabases, handleCanvasUpdate, handleUserComment, handleCNVUPD, resolveDataSourceId, setExclusiveInclude, markdownToRichNotionBlocks, findProperty, updateExistingEntryProperties, findRecentEmptyEntry } from "@/lib/entries";
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

const CREATABLE_ENTRY_TYPES: PageType[] = [
  "CHAT USER",
  "CHAT RESP",
  "MEMO EXPO",
  "MEMO RESP",
  "CHAT EXPO",
  "CHAT CMNT",
  "REPO SNAP",
];

const DEPRECATED_PAGE_TYPE_MAP: Record<string, PageType> = {
  "REG USR": "CHAT USER",
  "REG RES": "CHAT RESP",
  "REG EXP": "CHAT EXPO",
  "REG USR CMT": "CHAT CMNT",
  "CNV EXP": "MEMO EXPO",
  "CNV RES": "MEMO RESP",
  "CNV UPD": "MEMO UPDT",
  "Relink Databases": "SYST LINK",
};

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
  const rawPageTypeHeader =
    req.headers.get(PAGE_TYPE_HEADER) ||
    req.headers.get("cogdex-page-type") ||
    req.headers.get("x-cogdex-page-type");

  const pageTypeHeader = (rawPageTypeHeader && DEPRECATED_PAGE_TYPE_MAP[rawPageTypeHeader]) || rawPageTypeHeader;

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

  const rawId = payload?.data?.id;
  if (!rawId) {
    logError("Could not extract ID from payload:", payload);
    return Response.json(
      { error: "Could not extract page ID from Notion payload (expected data.id)" },
      { status: 400 }
    );
  }

  let entryId: string | undefined = undefined;
  let projectId = rawId;

  // Retrieve the triggering page to determine if it is an Entry page or a Project page
  const pageObj = await notion.pages.retrieve({ page_id: rawId }) as any;
  const parentId = pageObj?.parent?.database_id || pageObj?.parent?.data_source_id;
  const entryDbIdResolved = await resolveDataSourceId(process.env.NOTION_ENTRY_DB_ID || process.env.NOTION_ENTRIES_DB_ID!);

  if (parentId === entryDbIdResolved) {
    entryId = rawId;
    const projectProp = findProperty(pageObj.properties || {}, "Project");
    projectId = projectProp?.relation?.[0]?.id;
    if (!projectId) {
      return Response.json(
        { error: `Entry page ${entryId} is not linked to any Project.` },
        { status: 400 }
      );
    }
  } else if (CREATABLE_ENTRY_TYPES.includes(pageType)) {
    entryId = await findRecentEmptyEntry(projectId, pageType);
  }

  // --- Route to action ---
  try {
    if (pageType === "CHAT EXPO") {
      await exportAndCreate(projectId, false, entryId);
      return Response.json({ ok: true });
    }

    if (pageType === "MEMO EXPO") {
      await exportAndCreate(projectId, true, entryId);
      return Response.json({ ok: true });
    }

    if (pageType === "SYST LINK") {
      await relinkDatabases(projectId);
      return Response.json({ ok: true });
    }

    if (pageType === "MEMO RESP") {
      if (entryId) {
        await updateExistingEntryProperties({
          entryId,
          projectId,
          pageType: "MEMO RESP",
          pageObj,
        });
        await handleCanvasUpdate(entryId);
        return Response.json({ ok: true });
      } else {
        const result = await createEntry({ thoughtId: projectId, pageType: "MEMO RESP" });
        return Response.json({ ok: true, ...result });
      }
    }

    if (pageType === "MEMO UPDT") {
      await handleCNVUPD(projectId);
      return Response.json({ ok: true });
    }

    if (pageType === "CHAT CMNT") {
      await handleUserComment(entryId || projectId);
      return Response.json({ ok: true });
    }

    if (pageType === "REPO SNAP") {
      const projectPage = await notion.pages.retrieve({ page_id: projectId }) as any;
      const canvasRelations = projectPage.properties?.Canvas?.relation || [];
      if (canvasRelations.length === 0) {
        return Response.json({ error: "No Canvas entry linked to this project" }, { status: 400 });
      }
      
      const canvasId = canvasRelations[0].id;
      const canvasPage = await notion.pages.retrieve({ page_id: canvasId }) as any;
      
      const repoUrlProp = canvasPage.properties?.["Repo URL"] || Object.values(canvasPage.properties || {}).find((p: any) => p.id === "ySdk");
      const repoUrl = repoUrlProp?.rich_text?.[0]?.plain_text;
      
      if (!repoUrl) {
        const canvasTitle = canvasPage.properties?.Name?.title?.[0]?.plain_text || "Untitled";
        return Response.json(
          {
            error: `No Repo URL set on Canvas page "${canvasTitle}". Go to ${canvasPage.url} and fill in the "Repo URL" property.`,
          },
          { status: 400 }
        );
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

      let activeEntryId = entryId;
      if (activeEntryId) {
        await updateExistingEntryProperties({
          entryId: activeEntryId,
          projectId,
          pageType: "REPO SNAP",
          pageObj,
        });
      } else {
        const { pageId } = await createEntry({ thoughtId: projectId, pageType: "REPO SNAP" });
        activeEntryId = pageId;
      }

      if (activeEntryId) {
        await setExclusiveInclude(projectId, "REPO SNAP", activeEntryId);

        // write output in chunks
        const blocks = markdownToRichNotionBlocks(repomixOutput);
        const CHUNK = 100;
        for (let i = 0; i < blocks.length; i += CHUNK) {
          await notion.blocks.children.append({
            block_id: activeEntryId,
            children: blocks.slice(i, i + CHUNK) as any,
          });
        }
      }

      return Response.json({ ok: true });
    }

    if (entryId) {
      await updateExistingEntryProperties({
        entryId,
        projectId,
        pageType,
        pageObj,
      });
      return Response.json({ ok: true });
    } else {
      const result = await createEntry({ thoughtId: projectId, pageType });
      return Response.json({ ok: true, ...result });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal error";
    logError("Webhook error:", err);
    return Response.json({ error: message }, { status: 500 });
  }
}


