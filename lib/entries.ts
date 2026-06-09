import { notion } from "./notion";
import { PageType } from "./types";
import { debug, warn, error as logError } from "./logger";
import { readPageContent } from "./compile";

const ENTRY_DB_ID = process.env.NOTION_ENTRY_DB_ID || process.env.NOTION_ENTRIES_DB_ID!;
const SYSTEM_PROMPT_DB_ID = process.env.NOTION_SYSTEM_PROMPT_DB_ID!;

interface NotionPage {
  id: string;
  properties?: Record<string, {
    checkbox?: boolean;
    number?: number | null;
    title?: Array<{ plain_text?: string }>;
    select?: { name?: string } | null;
    relation?: Array<{ id: string }>;
  }>;
  icon?: {
    type: "emoji" | "external" | "file";
    emoji?: string;
    external?: { url: string };
    file?: { url: string };
  } | null;
}

const EMOJIS = [
  "🌿", "🌸", "🍁", "🍄", "🌴", "🌵", "🌶️", "🍇", "🥑", "🍋",
  "⭐", "🔥", "⚡", "💧", "🌈", "🌊", "❄️", "🌀", "🔮", "💎",
  "🤖", "👾", "🚀", "🛸", "🦖", "🦊", "🐙", "🦉", "🦁", "🦄",
  "🎨", "🎭", "🎪", "🎸", "🎯", "🧩", "🎲", "🎬", "🎤", "🛹",
  "🧭", "🔭", "🕯️", "🔑", "🛡️", "🧬", "🧪", "⚙️", "🔋", "🔔"
];

// Page body templates per Type
const TEMPLATES: Record<PageType, string> = {
  User: "",
  Response: "",
  Canvas: "",
  "Canvas Update": "",
  Compile: "", // filled by compile logic
  Branch: "",
  "New Branch": "",
  Reset: "",
};

function findProperty(properties: Record<string, any>, name: string): any {
  const targetKey = name.toLowerCase().replace(/\s+/g, "");
  const matchedKey = Object.keys(properties).find(
    (k) => k.toLowerCase().replace(/\s+/g, "") === targetKey
  );
  return matchedKey ? properties[matchedKey] : null;
}

export async function setRandomBranchIcon(branchId: string): Promise<string> {
  const randomEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  await notion.pages.update({
    page_id: branchId,
    icon: {
      type: "emoji",
      emoji: randomEmoji,
    },
  });
  debug(`Set random icon for branch ${branchId}: ${randomEmoji}`);
  return randomEmoji;
}


async function getBranchDbId(thoughtId: string): Promise<string> {
  let resolvedBranchDbId = process.env.NOTION_BRANCH_DB_ID;
  if (resolvedBranchDbId) return resolvedBranchDbId;

  try {
    const projectPage = await notion.pages.retrieve({ page_id: thoughtId }) as any;
    if (projectPage && projectPage.parent) {
      let projectDbId = "";
      if (projectPage.parent.type === "database_id") {
        projectDbId = projectPage.parent.database_id;
      } else if (projectPage.parent.type === "data_source_id") {
        projectDbId = projectPage.parent.data_source_id;
      }
      
      if (projectDbId) {
        const db = await notion.databases.retrieve({ database_id: projectDbId }) as any;
        const branchProp = findProperty(db.properties, "Branch");
        if (branchProp && branchProp.type === "relation" && branchProp.relation) {
          const dbId = branchProp.relation.database_id || branchProp.relation.data_source_id;
          if (dbId) return dbId;
        }
      }
    }
  } catch (err) {}

  return "379bd597-c2f9-80a3-a8b9-d8adba3f3d9e"; // user's new branch db id
}

async function getBranchesForProject(projectId: string, branchDbId: string) {
  const response = await notion.dataSources.query({
    data_source_id: branchDbId,
    filter: {
      property: "Project",
      relation: { contains: projectId },
    },
    sorts: [
      {
        timestamp: "created_time",
        direction: "descending",
      },
    ],
  });
  return response.results as unknown as NotionPage[];
}


// Returns the entry row sorted by created_time descending for this project (excluding Compile)
export async function getLatestEntry(thoughtId: string): Promise<NotionPage | null> {
  const response = await notion.dataSources.query({
    data_source_id: ENTRY_DB_ID,
    filter: {
      and: [
        { property: "Project", relation: { contains: thoughtId } },
        { property: "Type", select: { does_not_equal: "Compile" } },
      ],
    },
    sorts: [
      {
        timestamp: "created_time",
        direction: "descending",
      },
    ],
    page_size: 1,
  });

  if (response.results.length === 0) return null;
  return response.results[0] as unknown as NotionPage;
}

export async function handleNewBranchClick(projectId: string) {

  const branchDbId = await getBranchDbId(projectId);
  const branches = await getBranchesForProject(projectId, branchDbId);
  if (branches.length === 0) return;

  const newestBranch = branches[0];
  const randomEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  
  await notion.pages.update({
    page_id: newestBranch.id,
    properties: { 
      Active: { checkbox: true },
      Name: { title: [] } // Remove title from created one
    },
    icon: { type: "emoji", emoji: randomEmoji }, // Add random icon
  });

  for (let i = 1; i < branches.length; i++) {
    const b = branches[i];
    const isActive = findProperty(b.properties || {}, "Active")?.checkbox;
    if (isActive) {
      await notion.pages.update({
        page_id: b.id,
        properties: { Active: { checkbox: false } }
      });
    }
  }
}

export async function handleSetActiveClick(branchId: string) {
  const branchPage = await notion.pages.retrieve({ page_id: branchId }) as unknown as NotionPage;
  const projectId = findProperty(branchPage.properties || {}, "Project")?.relation?.[0]?.id;
  if (!projectId) return;

  const branchDbId = await getBranchDbId(projectId);
  const branches = await getBranchesForProject(projectId, branchDbId);

  for (const b of branches) {
    const shouldBeActive = b.id === branchId;
    const isCurrentlyActive = findProperty(b.properties || {}, "Active")?.checkbox;
    
    if (shouldBeActive && !isCurrentlyActive) {
      await notion.pages.update({
        page_id: b.id,
        properties: { Active: { checkbox: true } }
      });
    } else if (!shouldBeActive && isCurrentlyActive) {
      await notion.pages.update({
        page_id: b.id,
        properties: { Active: { checkbox: false } }
      });
    }
  }
}


export async function createEntry(params: {
  thoughtId: string;
  pageType: PageType;
}): Promise<{ pageId?: string; continueBranch?: boolean; ignored?: boolean }> {
  const { thoughtId, pageType } = params;
  const isCompile = pageType === "Compile";
  const resolvedBranchDbId = await getBranchDbId(thoughtId);

  // 1. Find targetEntryId if Notion button already created it
  let targetEntryId: string | undefined;
  const recentResponse = await notion.dataSources.query({
    data_source_id: ENTRY_DB_ID,
    filter: {
      and: [
        { property: "Project", relation: { contains: thoughtId } },
        { property: "Type", select: { equals: pageType } }
      ]
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 1
  });

  if (recentResponse.results.length > 0) {
    const recentPage = recentResponse.results[0] as any;
    if (pageType === "Canvas") {
      // For multiple Canvas entries, only reuse the page if it was created very recently (within 5 minutes)
      const createdTime = new Date(recentPage.created_time);
      const now = new Date();
      const diffMs = Math.abs(now.getTime() - createdTime.getTime());
      if (diffMs < 5 * 60 * 1000) {
        targetEntryId = recentPage.id;
        debug(`Found existing Canvas entry created by Notion: ${targetEntryId}`);
      }
    } else {
      targetEntryId = recentPage.id;
      debug(`Found existing entry created by Notion: ${targetEntryId}`);
    }
  }

  // 2. Resolve Active Branch
  const branches = await getBranchesForProject(thoughtId, resolvedBranchDbId);
  const activeBranch = branches.find(b => findProperty(b.properties || {}, "Active")?.checkbox);
  let linkedBranchId: string | undefined = activeBranch?.id;
  let inheritedTitle = "";
  let inheritedIcon: NotionPage["icon"] = undefined;

  if (activeBranch) {
    inheritedIcon = activeBranch.icon;
    
    // Find latest entry in this branch to inherit title (excluding the one we just found)
    const latestResponse = await notion.dataSources.query({
      data_source_id: ENTRY_DB_ID,
      filter: {
        and: [
          { property: "Branch", relation: { contains: activeBranch.id } }
        ]
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 2
    });
    
    const validEntries = latestResponse.results.filter((r: any) => r.id !== targetEntryId);
    if (validEntries.length > 0) {
      const nameProp = findProperty((validEntries[0] as any).properties || {}, "Name");
      inheritedTitle = nameProp?.title?.[0]?.plain_text ?? "";
    }
  } else {
    const randomEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
    debug(`Creating new Branch "init" in DB ${resolvedBranchDbId}`);
    try {
      const newBranchPage = await notion.pages.create({
        parent: { data_source_id: resolvedBranchDbId },
        properties: {
          Name: { title: [{ text: { content: "init" } }] },
          Project: { relation: [{ id: thoughtId }] },
          Active: { checkbox: true }
        },
        icon: { type: "emoji", emoji: randomEmoji }
      });
      linkedBranchId = newBranchPage.id;
      inheritedIcon = { type: "emoji", emoji: randomEmoji };
      try {
        await notion.pages.update({
          page_id: thoughtId,
          properties: { Branch: { relation: [{ id: linkedBranchId }] } }
        });
      } catch {}
    } catch (createBranchErr) {
      logError("Failed to create init branch:", createBranchErr);
      throw createBranchErr;
    }
  }

  // 3. Handle Canvas Logic
  // We no longer restrict one Canvas per branch for versioning.

  // 4. Update or Create Entry
  const properties: Record<string, unknown> = {
    Name: { title: inheritedTitle ? [{ text: { content: inheritedTitle } }] : [] },
    Type: { select: { name: pageType } },
    Include: { checkbox: true },
    Project: { relation: [{ id: thoughtId }] },
  };

  if (linkedBranchId) {
    properties.Branch = { relation: [{ id: linkedBranchId }] };
  }

  const blocksToAppend = (!isCompile && pageType !== "Branch" && pageType !== "New Branch") ? markdownToNotionBlocks(TEMPLATES[pageType]) : [];

  if (targetEntryId) {
    await notion.pages.update({
      page_id: targetEntryId,
      properties: properties as any,
      icon: (inheritedIcon as any) || undefined
    });
    if (blocksToAppend.length > 0) {
      await notion.blocks.children.append({
        block_id: targetEntryId,
        children: blocksToAppend as any
      });
    }
    return { pageId: targetEntryId, continueBranch: true };
  } else {
    const createPayload: any = {
      parent: { data_source_id: ENTRY_DB_ID },
      properties,
      children: blocksToAppend,
    };
    if (inheritedIcon) createPayload.icon = inheritedIcon;

    const page = await notion.pages.create(createPayload);
    return { pageId: page.id, continueBranch: true };
  }
}

// Minimal markdown-to-Notion-blocks converter for templates.
// Only handles headings (##) and paragraphs — intentionally minimal.
function markdownToNotionBlocks(md: string): Record<string, unknown>[] {
  const lines = md.split("\n");
  const blocks: Record<string, unknown>[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ type: "text", text: { content: line.slice(3) } }],
        },
      });
    } else {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: line } }],
        },
      });
    }
  }

  return blocks;
}

export async function relinkDatabases(thoughtId: string): Promise<void> {
  debug(`Starting relinkDatabases for page ${thoughtId}`);

  // 1. Fetch original view configurations to clone sorting/ordering/formatting
  const ORIGINAL_BRANCH_VIEW_ID = process.env.NOTION_BRANCH_VIEW_ID;
  const ORIGINAL_ENTRY_VIEW_ID = process.env.NOTION_ENTRY_VIEW_ID;
  const ORIGINAL_SYSTEM_PROMPT_VIEW_ID = process.env.NOTION_SYSTEM_PROMPT_VIEW_ID;

  if (!ORIGINAL_BRANCH_VIEW_ID || !ORIGINAL_ENTRY_VIEW_ID || !ORIGINAL_SYSTEM_PROMPT_VIEW_ID) {
    throw new Error(
      "Missing required view ID environment variables: NOTION_BRANCH_VIEW_ID, NOTION_ENTRY_VIEW_ID, NOTION_SYSTEM_PROMPT_VIEW_ID"
    );
  }

  debug(`Fetching original views: Branch=${ORIGINAL_BRANCH_VIEW_ID}, Entry=${ORIGINAL_ENTRY_VIEW_ID}, SystemPrompt=${ORIGINAL_SYSTEM_PROMPT_VIEW_ID}`);
  const [branchView, entryView, systemPromptView] = await Promise.all([
    notion.views.retrieve({ view_id: ORIGINAL_BRANCH_VIEW_ID }),
    notion.views.retrieve({ view_id: ORIGINAL_ENTRY_VIEW_ID }),
    notion.views.retrieve({ view_id: ORIGINAL_SYSTEM_PROMPT_VIEW_ID }),
  ]);

  // 2. Wipe clean all blocks inside the current page
  let hasMore = true;
  let startCursor: string | undefined = undefined;

  while (hasMore) {
    const listResponse = await notion.blocks.children.list({
      block_id: thoughtId,
      start_cursor: startCursor,
    });

    if (listResponse.results.length > 0) {
      await Promise.all(
        listResponse.results.map((block) =>
          notion.blocks.delete({ block_id: block.id })
        )
      );
    }

    hasMore = listResponse.has_more;
    startCursor = listResponse.next_cursor ?? undefined;
  }
  debug("Wiped clean all blocks inside project page");

  // 3. Resolve Branch DB ID for fallback
  let branchDbId = process.env.NOTION_BRANCH_DB_ID;
  if (!branchDbId) {
    try {
      const projectPage = await notion.pages.retrieve({ page_id: thoughtId });
      if (projectPage && (projectPage as any).parent) {
        let projectDbId = "";
        const parent = (projectPage as any).parent;
        if (parent.type === "database_id") {
          projectDbId = parent.database_id;
        } else if (parent.type === "data_source_id") {
          projectDbId = parent.data_source_id;
        }

        if (projectDbId) {
          const db = await notion.databases.retrieve({ database_id: projectDbId }) as any;
          const branchProp = findProperty(db.properties, "Branch");
          if (branchProp && branchProp.type === "relation" && branchProp.relation) {
            const dbId = branchProp.relation.database_id || branchProp.relation.data_source_id;
            if (dbId) {
              branchDbId = dbId;
            }
          }
        }
      }
    } catch (err) {
      warn("Could not dynamically resolve Branch DB ID:", err);
    }
  }

  if (!branchDbId) {
    branchDbId = "375bd597-c2f9-80cb-9055-f69d21f54170";
  }

  // 4. Helper to create view cloned from original
  const createClonedView = async (
    originalView: any,
    fallbackDataSourceId: string,
    modifyFilter?: (filter: any) => any
  ) => {
    const dataSourceId = originalView.data_source_id || fallbackDataSourceId;
    const name = originalView.name || "View";
    const type = originalView.type || "table";
    const sorts = originalView.sorts || undefined;
    
    let configuration = originalView.configuration || undefined;
    try {
      debug(`Retrieving actual schema for data source ${dataSourceId} to sanitize property configurations`);
      const db = await notion.dataSources.retrieve({ data_source_id: dataSourceId }) as any;
      const validPropertyIds = new Set(
        Object.values(db.properties).flatMap((prop: any) => [
          prop.id,
          decodeURIComponent(prop.id),
          encodeURIComponent(prop.id),
        ])
      );
      validPropertyIds.add("title");

      if (configuration && configuration.properties && Array.isArray(configuration.properties)) {
        configuration.properties = configuration.properties.filter((p: any) => {
          if (!p.property_id) return false;
          const decoded = decodeURIComponent(p.property_id);
          const encoded = encodeURIComponent(p.property_id);
          return (
            validPropertyIds.has(p.property_id) ||
            validPropertyIds.has(decoded) ||
            validPropertyIds.has(encoded)
          );
        });
        debug(`Sanitized properties list: kept ${configuration.properties.length} valid properties`);
      }
    } catch (schemaErr) {
      warn(`Could not retrieve schema for data source ${dataSourceId} to sanitize configuration:`, schemaErr);
    }

    let filter = originalView.filter || undefined;
    if (modifyFilter) {
      filter = modifyFilter(filter);
    }

    await notion.views.create({
      data_source_id: dataSourceId,
      name,
      type,
      create_database: {
        parent: {
          type: "page_id",
          page_id: thoughtId,
        },
      },
      filter,
      sorts,
      configuration,
    } as any);
  };

  // Modifier to enforce scoping to current project
  const projectFilterModifier = (origFilter: any) => {
    const projectFilter = {
      property: "Project",
      relation: {
        contains: thoughtId,
      },
    };
    if (!origFilter) {
      return projectFilter;
    }
    return {
      and: [
        projectFilter,
        origFilter,
      ],
    };
  };

  // 5. Create the cloned views sequentially
  debug("Creating cloned Branch database view");
  await createClonedView(branchView, branchDbId, projectFilterModifier);

  debug("Creating cloned Entry database view");
  await createClonedView(entryView, ENTRY_DB_ID, projectFilterModifier);

  debug("Creating cloned System Prompt database view");
  await createClonedView(systemPromptView, SYSTEM_PROMPT_DB_ID);

  debug(`Successfully finished relinkDatabases for page ${thoughtId}`);
}

export function isDiff(content: string): boolean {
  if (/^@@\s+-\d+.*\+\d+.*@@/m.test(content)) {
    return true;
  }
  const lines = content.split("\n");
  let diffIndicators = 0;
  for (const line of lines) {
    if (line.startsWith("+") || line.startsWith("-")) {
      diffIndicators++;
    }
  }
  return diffIndicators > 0 || content.includes("--- ") || content.includes("+++ ");
}

interface Hunk {
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  lines: string[];
}

export function parseDiff(diffText: string): Hunk[] {
  let content = diffText;
  const match = diffText.match(/```(?:diff)?\n([\s\S]*?)```/);
  if (match) {
    content = match[1];
  }

  const lines = content.split(/\r?\n/);
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  for (const line of lines) {
    const hunkHeaderMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkHeaderMatch) {
      if (currentHunk) {
        while (currentHunk.lines.length > 0 && currentHunk.lines[currentHunk.lines.length - 1].trim() === "") {
          currentHunk.lines.pop();
        }
        hunks.push(currentHunk);
      }
      currentHunk = {
        oldStart: parseInt(hunkHeaderMatch[1], 10),
        oldLength: hunkHeaderMatch[2] ? parseInt(hunkHeaderMatch[2], 10) : 1,
        newStart: parseInt(hunkHeaderMatch[3], 10),
        newLength: hunkHeaderMatch[4] ? parseInt(hunkHeaderMatch[4], 10) : 1,
        lines: [],
      };
    } else if (currentHunk) {
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "" || line.startsWith("\\")) {
        currentHunk.lines.push(line);
      } else {
        if (!line.startsWith("diff ") && !line.startsWith("--- ") && !line.startsWith("+++ ")) {
          currentHunk.lines.push(" " + line);
        }
      }
    }
  }
  if (currentHunk) {
    while (currentHunk.lines.length > 0 && currentHunk.lines[currentHunk.lines.length - 1].trim() === "") {
      currentHunk.lines.pop();
    }
    hunks.push(currentHunk);
  }
  return hunks;
}

function matchLines(baseLines: string[], startIdx: number, searchLines: string[]): boolean {
  for (let i = 0; i < searchLines.length; i++) {
    if (baseLines[startIdx + i].trim() !== searchLines[i].trim()) {
      return false;
    }
  }
  return true;
}

export function applyPatch(baseText: string, patchText: string): string {
  const hunks = parseDiff(patchText);
  if (hunks.length === 0) {
    return patchText;
  }

  const baseLines = baseText.split(/\r?\n/);
  const sortedHunks = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sortedHunks) {
    const searchLines: string[] = [];
    const replaceLines: string[] = [];

    for (const line of hunk.lines) {
      if (line.startsWith("-")) {
        searchLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        replaceLines.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        searchLines.push(line.slice(1));
        replaceLines.push(line.slice(1));
      } else if (line.startsWith("\\")) {
        // Ignore
      } else {
        searchLines.push(line);
        replaceLines.push(line);
      }
    }

    const hintIndex = Math.max(0, hunk.oldStart - 1);
    let foundIndex = -1;
    const maxOffset = Math.max(baseLines.length, 100);

    for (let offset = 0; offset < maxOffset; offset++) {
      const idxForward = hintIndex + offset;
      if (idxForward + searchLines.length <= baseLines.length) {
        if (matchLines(baseLines, idxForward, searchLines)) {
          foundIndex = idxForward;
          break;
        }
      }
      const idxBackward = hintIndex - offset;
      if (offset > 0 && idxBackward >= 0 && idxBackward + searchLines.length <= baseLines.length) {
        if (matchLines(baseLines, idxBackward, searchLines)) {
          foundIndex = idxBackward;
          break;
        }
      }
    }

    if (foundIndex === -1) {
      let startTrim = 0;
      while (startTrim < searchLines.length && hunk.lines[startTrim]?.startsWith(" ")) {
        startTrim++;
      }
      let endTrim = 0;
      while (endTrim < searchLines.length && hunk.lines[hunk.lines.length - 1 - endTrim]?.startsWith(" ")) {
        endTrim++;
      }

      const trimmedSearch = searchLines.slice(startTrim, searchLines.length - endTrim);
      const trimmedReplace = replaceLines.slice(startTrim, replaceLines.length - endTrim);

      if (trimmedSearch.length > 0) {
        for (let offset = 0; offset < maxOffset; offset++) {
          const idxForward = hintIndex + offset;
          if (idxForward + trimmedSearch.length <= baseLines.length) {
            if (matchLines(baseLines, idxForward, trimmedSearch)) {
              foundIndex = idxForward - startTrim;
              break;
            }
          }
          const idxBackward = hintIndex - offset;
          if (offset > 0 && idxBackward >= 0 && idxBackward + trimmedSearch.length <= baseLines.length) {
            if (matchLines(baseLines, idxBackward, trimmedSearch)) {
              foundIndex = idxBackward - startTrim;
              break;
            }
          }
        }
      }
    }

    if (foundIndex !== -1) {
      baseLines.splice(foundIndex, searchLines.length, ...replaceLines);
    } else {
      if (baseText.trim() === "") {
        return replaceLines.join("\n");
      }
      warn(`Could not apply hunk starting at line ${hunk.oldStart}`);
    }
  }

  return baseLines.join("\n");
}

export function textToNotionBlocks(text: string): Record<string, unknown>[] {
  const lines = text.split(/\r?\n/);
  const blocks: Record<string, unknown>[] = [];
  let currentChunk: string[] = [];
  let currentLength = 0;

  for (const line of lines) {
    if (currentLength + line.length + 1 > 1900) {
      if (currentChunk.length > 0) {
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: currentChunk.join("\n") } }],
          },
        });
        currentChunk = [];
        currentLength = 0;
      }
    }

    if (line.length > 1900) {
      let remaining = line;
      while (remaining.length > 0) {
        const piece = remaining.slice(0, 1900);
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: piece } }],
          },
        });
        remaining = remaining.slice(1900);
      }
    } else {
      currentChunk.push(line);
      currentLength += line.length + 1;
    }
  }

  if (currentChunk.length > 0) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: currentChunk.join("\n") } }],
      },
    });
  }

  return blocks;
}

export async function handleCanvasUpdate(triggeredId: string): Promise<void> {
  debug(`Starting handleCanvasUpdate for ID: ${triggeredId}`);

  // Retrieve the page from Notion
  const pageObj = await notion.pages.retrieve({ page_id: triggeredId }) as any;
  if (!pageObj) {
    throw new Error(`Page with ID ${triggeredId} not found.`);
  }

  let canvasEntryId = "";
  let projectId = "";

  const parentId = pageObj.parent.database_id || pageObj.parent.data_source_id;

  if (parentId === ENTRY_DB_ID) {
    debug(`Triggered page ${triggeredId} is a Canvas Entry`);
    canvasEntryId = triggeredId;
    const projectProp = findProperty(pageObj.properties || {}, "Project");
    projectId = projectProp?.relation?.[0]?.id;
    if (!projectId) {
      throw new Error(`Canvas Entry ${triggeredId} is not linked to any Project.`);
    }
  } else {
    debug(`Triggered page ${triggeredId} is a Project page, searching for latest Canvas Entry`);
    projectId = triggeredId;
    const canvasPagesResponse = await notion.dataSources.query({
      data_source_id: ENTRY_DB_ID,
      filter: {
        and: [
          { property: "Project", relation: { contains: projectId } },
          { property: "Type", select: { equals: "Canvas" } }
        ]
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 1
    });

    if (canvasPagesResponse.results.length === 0) {
      throw new Error(`No Canvas entry found for project ${projectId}.`);
    }
    canvasEntryId = canvasPagesResponse.results[0].id;
  }

  // 1. Read diff content from target canvas page
  const diffContent = await readPageContent(canvasEntryId);
  debug(`Read diff content from canvas ${canvasEntryId} (length: ${diffContent.length})`);

  if (!isDiff(diffContent)) {
    debug(`Content is not a git diff. Skipping merge update.`);
    return;
  }

  // 2. Find previous canvas page in this project
  const canvasPagesResponse = await notion.dataSources.query({
    data_source_id: ENTRY_DB_ID,
    filter: {
      and: [
        { property: "Project", relation: { contains: projectId } },
        { property: "Type", select: { equals: "Canvas" } }
      ]
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }]
  });

  const results = canvasPagesResponse.results;
  const currentIdx = results.findIndex(r => r.id === canvasEntryId);
  let previousCanvasId: string | null = null;
  if (currentIdx !== -1 && currentIdx + 1 < results.length) {
    previousCanvasId = results[currentIdx + 1].id;
  }

  let baseContent = "";
  if (previousCanvasId) {
    debug(`Found previous canvas: ${previousCanvasId}`);
    baseContent = await readPageContent(previousCanvasId);
  } else {
    debug(`No previous canvas found for project ${projectId}. Using empty content as base.`);
  }

  // 3. Apply git diff to get merged content
  const mergedContent = applyPatch(baseContent, diffContent);
  debug(`Merged content length: ${mergedContent.length}`);

  // 4. Overwrite current canvas page content
  let hasMore = true;
  let startCursor: string | undefined = undefined;

  // Clear existing blocks
  while (hasMore) {
    const listResponse = await notion.blocks.children.list({
      block_id: canvasEntryId,
      start_cursor: startCursor,
    });

    if (listResponse.results.length > 0) {
      await Promise.all(
        listResponse.results.map((block) =>
          notion.blocks.delete({ block_id: block.id })
        )
      );
    }

    hasMore = listResponse.has_more;
    startCursor = listResponse.next_cursor ?? undefined;
  }
  debug("Wiped clean all blocks inside canvas page");

  // Write merged content as blocks
  const blocks = textToNotionBlocks(mergedContent);
  const CHUNK = 100;
  for (let i = 0; i < blocks.length; i += CHUNK) {
    await notion.blocks.children.append({
      block_id: canvasEntryId,
      children: blocks.slice(i, i + CHUNK) as any,
    });
  }
  debug(`Finished writing merged content back to canvas page ${canvasEntryId}`);
}
