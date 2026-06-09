import { notion } from "./notion";
import { PageType } from "./types";
import { debug, warn, error as logError } from "./logger";

const ENTRY_DB_ID = process.env.NOTION_ENTRY_DB_ID || process.env.NOTION_ENTRIES_DB_ID!;
const SYSTEM_PROMPT_DB_ID = process.env.NOTION_SYSTEM_PROMPT_DB_ID!;

interface NotionPage {
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

// Read Continue Branch flag from a Project page
export async function getContinueBranch(thoughtId: string): Promise<boolean> {
  const page = await notion.pages.retrieve({ page_id: thoughtId });
  const p = page as unknown as NotionPage;
  if (!p.properties) {
    logError("No properties found on Project page response:", p);
    return false;
  }

  // Find key case-insensitively and stripping whitespace
  const targetKey = "continuebranch";
  const matchedKey = Object.keys(p.properties).find(
    (k) => k.toLowerCase().replace(/\s+/g, "") === targetKey
  );

  if (!matchedKey) {
    warn(
      `"Continue Branch" property not found on Project page. Available properties:`,
      Object.keys(p.properties)
    );
    return false;
  }

  const isChecked = p.properties[matchedKey]?.checkbox ?? false;
  debug(`Found property "${matchedKey}", value is:`, isChecked);
  return isChecked;
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

export async function createEntry(params: {
  thoughtId: string;
  pageType: PageType;
}): Promise<{ pageId: string; continueBranch: boolean }> {
  const { thoughtId, pageType } = params;

  const isCompile = pageType === "Compile";

  let inheritedTitle = "";
  let inheritedIcon: NotionPage["icon"] = undefined;
  let continueBranch = false;
  let linkedBranchId: string | undefined = undefined;

  // 1. Retrieve Project page parent and try to dynamically resolve Branch Database ID
  let resolvedBranchDbId = process.env.NOTION_BRANCH_DB_ID;
  let projectPage: any = null;

  try {
    projectPage = await notion.pages.retrieve({ page_id: thoughtId });
    if (!resolvedBranchDbId && projectPage && projectPage.parent) {
      let projectDbId = "";
      if (projectPage.parent.type === "database_id") {
        projectDbId = (projectPage.parent as any).database_id;
      } else if (projectPage.parent.type === "data_source_id") {
        projectDbId = (projectPage.parent as any).data_source_id;
      }
      
      if (projectDbId) {
        debug(`Retrieved Project parent database ID: ${projectDbId}`);
        try {
          const db = await notion.databases.retrieve({ database_id: projectDbId }) as any;
          const branchProp = findProperty(db.properties, "Branch");
          if (branchProp && branchProp.type === "relation" && branchProp.relation) {
            const dbId = branchProp.relation.database_id || branchProp.relation.data_source_id;
            if (dbId) {
              resolvedBranchDbId = dbId;
              debug(`Dynamically resolved Branch DB ID from Project schema: ${resolvedBranchDbId}`);
            } else {
              warn(`Branch relation schema found, but database_id/data_source_id is missing:`, branchProp);
            }
          } else {
            warn(`Branch property not found on Project database schema:`, db.properties);
          }
        } catch (dbErr) {
          warn(`Could not retrieve Project parent database ${projectDbId} schema:`, dbErr);
        }
      }
    }
  } catch (err) {
    warn(`Could not retrieve Project page ${thoughtId} properties:`, err);
  }

  if (!resolvedBranchDbId) {
    resolvedBranchDbId = "375bd597-c2f9-80cb-9055-f69d21f54170";
  }

  // Retrieve Continue Branch flag
  continueBranch = await getContinueBranch(thoughtId);
  debug(`continueBranch resolved from database:`, continueBranch);

  if (continueBranch) {
    // Try to get branch from Project page properties
    if (projectPage && projectPage.properties) {
      const branchProp = findProperty(projectPage.properties, "Branch");
      const branchId = branchProp?.relation?.[0]?.id;
      if (branchId) {
        linkedBranchId = branchId;
        debug(`Found branch from Project properties: ${branchId}`);
      }
    }

    // If not found, try to get branch from the latest Entry for this project
    if (!linkedBranchId) {
      const latest = await getLatestEntry(thoughtId);
      if (latest && latest.properties) {
        const branchProp = findProperty(latest.properties, "Branch");
        const branchId = branchProp?.relation?.[0]?.id;
        if (branchId) {
          linkedBranchId = branchId;
          debug(`Found branch from latest Entry: ${branchId}`);
        }

        // Get title if continueBranch is true
        const nameProp = findProperty(latest.properties, "Name");
        inheritedTitle = nameProp?.title?.[0]?.plain_text ?? "";
      }
    } else {
      // If we found branch from Project, still get inherited title from latest Entry
      const latest = await getLatestEntry(thoughtId);
      if (latest && latest.properties) {
        const nameProp = findProperty(latest.properties, "Name");
        inheritedTitle = nameProp?.title?.[0]?.plain_text ?? "";
      }
    }
  }

  // If no branch was found (or continueBranch is false), create a new Branch "start"
  if (!linkedBranchId) {
    const randomEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
    debug(`Creating new Branch "start" in DB ${resolvedBranchDbId} with icon ${randomEmoji}`);
    try {
      const newBranchPage = await notion.pages.create({
        parent: { data_source_id: resolvedBranchDbId },
        properties: {
          Name: {
            title: [{ text: { content: "start" } }]
          },
          Project: {
            relation: [{ id: thoughtId }]
          }
        },
        icon: {
          type: "emoji",
          emoji: randomEmoji
        }
      });
      linkedBranchId = newBranchPage.id;
      inheritedIcon = {
        type: "emoji",
        emoji: randomEmoji
      };
      debug(`Created branch ID: ${linkedBranchId}`);

      // Update Project page's Branch relation to point to this new Branch
      try {
        await notion.pages.update({
          page_id: thoughtId,
          properties: {
            Branch: {
              relation: [{ id: linkedBranchId }]
            }
          }
        });
        debug(`Updated Project page ${thoughtId} with new Branch relation`);
      } catch (updateProjectErr) {
        warn(`Could not update Project ${thoughtId} branch relation:`, updateProjectErr);
      }
    } catch (createBranchErr: any) {
      logError("Failed to create start branch:", createBranchErr);
      if (createBranchErr?.code === "object_not_found") {
        throw new Error(
          `Could not access Branch database with ID: ${resolvedBranchDbId}. ` +
          `Please make sure you have connected/shared your Notion integration ` +
          `("Notion and VS Code" or "Cogdex App") with the Branch database in Notion (click ... -> Connections -> Add Connection).`
        );
      }
      throw createBranchErr;
    }
  } else {
    // Fetch icon from existing branch
    try {
      const branchPage = await notion.pages.retrieve({ page_id: linkedBranchId });
      const bp = branchPage as any;
      if (bp.icon) {
        inheritedIcon = bp.icon;
        debug(`Inherited icon from Branch:`, inheritedIcon);
      }
    } catch (branchErr) {
      warn(`Could not retrieve Branch page ${linkedBranchId}:`, branchErr);
    }
  }

  // --- Build properties ---
  const properties: Record<string, unknown> = {
    Name: {
      title: [{ text: { content: inheritedTitle } }],
    },
    Type: { select: { name: pageType } },
    Include: { checkbox: true },
    Project: { relation: [{ id: thoughtId }] },
  };

  if (linkedBranchId) {
    properties.Branch = { relation: [{ id: linkedBranchId }] };
  }

  // --- Build pages.create payload ---
  const createPayload: {
    parent: { data_source_id: string };
    properties: Record<string, unknown>;
    children: Record<string, unknown>[];
    icon?: NotionPage["icon"];
  } = {
    parent: { data_source_id: ENTRY_DB_ID },
    properties,
    children:
      (!isCompile && pageType !== "Branch") ? markdownToNotionBlocks(TEMPLATES[pageType]) : [],
  };

  if (inheritedIcon) {
    createPayload.icon = inheritedIcon;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = await notion.pages.create(createPayload as any);
  return { pageId: page.id, continueBranch };
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
    const configuration = originalView.configuration || undefined;

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
