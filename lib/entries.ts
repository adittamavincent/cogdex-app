import { notion } from "./notion";
import { PageType } from "./types";
import { debug, warn, error as logError } from "./logger";

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
  User: "## Intent\n\n\n## Brain Dump\n\n",
  Response: "## LLM Response\n\n",
  Canvas: "## Canvas\n\n",
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
  let inheritedTitle = "";
  let inheritedIcon: NotionPage["icon"] = undefined;
  const resolvedBranchDbId = await getBranchDbId(thoughtId);

  const branches = await getBranchesForProject(thoughtId, resolvedBranchDbId);
  const activeBranch = branches.find(b => findProperty(b.properties || {}, "Active")?.checkbox);
  let linkedBranchId: string | undefined = activeBranch?.id;

  if (activeBranch) {
    inheritedIcon = activeBranch.icon;
    const latest = await getLatestEntry(thoughtId);
    if (latest && latest.properties) {
      const nameProp = findProperty(latest.properties, "Name");
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

  if (pageType === "Canvas" && linkedBranchId) {
    const existingCanvasResponse = await notion.dataSources.query({
      data_source_id: ENTRY_DB_ID,
      filter: {
        and: [
          { property: "Branch", relation: { contains: linkedBranchId } },
          { property: "Type", select: { equals: "Canvas" } }
        ]
      },
      page_size: 1
    });
    if (existingCanvasResponse.results.length > 0) {
      debug(`Canvas already exists in branch ${linkedBranchId}, ignoring`);
      return { ignored: true };
    }
  }

  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: inheritedTitle } }] },
    Type: { select: { name: pageType } },
    Include: { checkbox: true },
    Project: { relation: [{ id: thoughtId }] },
  };

  if (linkedBranchId) {
    properties.Branch = { relation: [{ id: linkedBranchId }] };
  }

  const createPayload: any = {
    parent: { data_source_id: ENTRY_DB_ID },
    properties,
    children: (!isCompile && pageType !== "Branch" && pageType !== "New Branch") ? markdownToNotionBlocks(TEMPLATES[pageType]) : [],
  };

  if (inheritedIcon) createPayload.icon = inheritedIcon;

  const page = await notion.pages.create(createPayload);
  return { pageId: page.id, continueBranch: true };
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
