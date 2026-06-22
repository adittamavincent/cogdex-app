import type { NextRequest } from "next/server";
import type { NotionAutomationPayload, PageType } from "@/lib/types";
import { notion } from "@/lib/notion";
import { createEntry, handleSystemLink, handleUserComment, handleMemoUpdate, resolveDataSourceId, setExclusiveInclude, markdownToRichNotionBlocks, compileRepomixToCodeBlocks, findProperty, updateExistingEntryProperties, findRecentEmptyEntry, handleChatLink, getNextEntryNumber } from "@/lib/entries";
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
  "TASK EXPO",
  "TASK RESP",
  "CHAT LINK",
];

const CREATABLE_ENTRY_TYPES: PageType[] = [
  "CHAT USER",
  "CHAT RESP",
  "MEMO EXPO",
  "MEMO RESP",
  "CHAT EXPO",
  "CHAT CMNT",
  "REPO SNAP",
  "TASK EXPO",
  "TASK RESP",
  "CHAT LINK",
];


export async function POST(req: NextRequest) {
  // --- Auth ---
  const incomingSecret =
    req.headers.get(SECRET_HEADER) ||
    req.headers.get("coged-secret") ||
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

  const pageTypeHeader = rawPageTypeHeader;

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
  const parentIdResolved = parentId ? await resolveDataSourceId(parentId) : undefined;
  const entryDbIdResolved = await resolveDataSourceId(process.env.NOTION_ENTRY_DB_ID || process.env.NOTION_ENTRIES_DB_ID!);

  if (parentIdResolved === entryDbIdResolved) {
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
    if (pageType === "CHAT LINK") {
      await handleChatLink(projectId, entryId, pageObj);
      return Response.json({ ok: true });
    }

    if (pageType === "CHAT EXPO") {
      await exportAndCreate(projectId, false, entryId);
      return Response.json({ ok: true });
    }

    if (pageType === "TASK EXPO") {
      await exportAndCreate(projectId, "TASK EXPO", entryId);
      return Response.json({ ok: true });
    }

    if (pageType === "MEMO EXPO") {
      await exportAndCreate(projectId, true, entryId);
      return Response.json({ ok: true });
    }

    if (pageType === "TASK RESP") {
      if (entryId) {
        await updateExistingEntryProperties({
          entryId,
          projectId,
          pageType: "TASK RESP",
          pageObj,
        });
        return Response.json({ ok: true });
      } else {
        const result = await createEntry({ thoughtId: projectId, pageType: "TASK RESP" });
        return Response.json({ ok: true, ...result });
      }
    }

    if (pageType === "SYST LINK") {
      await handleSystemLink(projectId);
      return Response.json({ ok: true });
    }



    if (pageType === "MEMO UPDT") {
      await handleMemoUpdate(projectId);
      return Response.json({ ok: true });
    }

    if (pageType === "CHAT CMNT") {
      await handleUserComment(entryId || projectId);
      return Response.json({ ok: true });
    }

    if (pageType === "REPO SNAP") {
      const projectPage = await notion.pages.retrieve({ page_id: projectId }) as any;
      const memorandumRelations = projectPage.properties?.Memorandum?.relation || [];
      if (memorandumRelations.length === 0) {
        return Response.json({ error: "No Memorandum entry linked to this project" }, { status: 400 });
      }
      
      const memorandumId = memorandumRelations[0].id;
      const memorandumPage = await notion.pages.retrieve({ page_id: memorandumId }) as any;
      
      const repoUrlProp = memorandumPage.properties?.["Repo URL"] || Object.values(memorandumPage.properties || {}).find((p: any) => p.id === "ySdk");
      const repoUrl = repoUrlProp?.rich_text?.[0]?.plain_text || repoUrlProp?.url;
      
      if (!repoUrl) {
        const memorandumTitle = memorandumPage.properties?.Name?.title?.[0]?.plain_text || "Untitled";
        return Response.json(
          {
            error: `No Repo URL set on Memorandum page "${memorandumTitle}". Go to ${memorandumPage.url} and fill in the "Repo URL" property.`,
          },
          { status: 400 }
        );
      }

      // Parse GitHub URL to owner/repo for tarball download
      const parseGitHub = (url: string): { owner: string; repo: string; branch?: string } | null => {
        const shorthand = url.match(/^([^/\s]+)\/([^/\s]+)$/);
        if (shorthand) return { owner: shorthand[1], repo: shorthand[2] };
        const full = url.match(/github\.com[:/]([^/]+)\/([^/.#\s]+)(?:\.git)?(?:\/tree\/([^\s]+))?/);
        if (full) return { owner: full[1], repo: full[2], branch: full[3] };
        return null;
      };

      const ghInfo = parseGitHub(repoUrl);
      if (!ghInfo) {
        return Response.json({ error: `Only GitHub URLs are supported for REPO SNAP. Got: ${repoUrl}` }, { status: 400 });
      }

      let commitId = "";
      try {
        const ref = ghInfo.branch || "HEAD";
        const shaResponse = await fetch(`https://api.github.com/repos/${ghInfo.owner}/${ghInfo.repo}/commits/${ref}`, {
          headers: { "Accept": "application/vnd.github.sha", "User-Agent": "cogdex-app" },
        });
        if (shaResponse.ok) {
          const sha = await shaResponse.text();
          commitId = sha.trim().slice(0, 7);
        }
      } catch (err) {
        console.error("Failed to fetch commit SHA:", err);
      }

      // Download tarball from GitHub API, extract locally, run repomix (no git binary needed)
      const repomixPromise = async () => {
        const { runCli } = await import("repomix");
        const fs = await import("fs/promises");
        const path = await import("path");
        const os = await import("os");
        const crypto = await import("crypto");
        const { execSync } = await import("child_process");

        const tmpDir = path.join(os.tmpdir(), `cogdex-repo-${crypto.randomUUID()}`);
        await fs.mkdir(tmpDir, { recursive: true });

        try {
          // 1. Download tarball from GitHub API
          const ref = ghInfo.branch || "HEAD";
          const tarballUrl = `https://api.github.com/repos/${ghInfo.owner}/${ghInfo.repo}/tarball/${ref}`;
          const tarResponse = await fetch(tarballUrl, {
            headers: { "Accept": "application/vnd.github+json", "User-Agent": "cogdex-app" },
            redirect: "follow",
          });
          if (!tarResponse.ok) {
            throw new Error(`GitHub tarball download failed: ${tarResponse.status} ${tarResponse.statusText}`);
          }

          // 2. Write and extract tarball
          const tarPath = path.join(tmpDir, "repo.tar.gz");
          const buffer = Buffer.from(await tarResponse.arrayBuffer());
          await fs.writeFile(tarPath, buffer);

          const extractDir = path.join(tmpDir, "extracted");
          await fs.mkdir(extractDir, { recursive: true });
          execSync(`tar xzf "${tarPath}" -C "${extractDir}" --strip-components=1`, { timeout: 15000 });

          // 3. Run repomix locally on extracted files (no --remote, no git needed)
          const tempFile = path.join(tmpDir, "repomix-output.txt");
          try {
            await runCli([], extractDir, { output: tempFile, compress: true });
          } catch (err: any) {
            logError("Repomix with compress failed, falling back without compress:", err);
            await runCli([], extractDir, { output: tempFile, compress: false });
          }

          const content = await fs.readFile(tempFile, "utf-8");
          return content;
        } finally {
          // 4. Cleanup temp files
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
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

      repomixOutput += "\n\n😊";

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
        let entryNumber = "";
        try {
          const entryPageObj = await notion.pages.retrieve({ page_id: activeEntryId }) as any;
          const nameProp = findProperty(entryPageObj.properties || {}, "Name");
          const currentName = nameProp?.title?.[0]?.plain_text ?? "";
          if (/^\d+$/.test(currentName.trim())) {
            entryNumber = currentName.trim();
          } else {
            const nextNum = await getNextEntryNumber(projectId);
            entryNumber = String(nextNum);
          }
        } catch (err) {
          console.error("Failed to retrieve entry page name:", err);
        }

        if (entryNumber) {
          const finalTitle = commitId ? `${entryNumber} - ${commitId}` : entryNumber;
          await notion.pages.update({
            page_id: activeEntryId,
            properties: {
              Name: { title: [{ text: { content: finalTitle } }] }
            }
          });
        }
      }

      if (activeEntryId) {
        await setExclusiveInclude(projectId, "REPO SNAP", activeEntryId);

        // write output in chunks
        const blocks = compileRepomixToCodeBlocks(repomixOutput);
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


