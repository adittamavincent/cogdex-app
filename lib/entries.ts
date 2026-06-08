import { notion } from "./notion";
import { PageType } from "./types";
import { debug, warn, error as logError } from "./logger";

const ENTRIES_DB_ID = process.env.NOTION_ENTRIES_DB_ID!;
const BRANCH_DB_ID = process.env.NOTION_BRANCH_DB_ID || "375bd597-c2f9-80cb-9055-f69d21f54170";

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
  Agreement: "## Decisions\n\n\n## Definitions\n\n\n## Open Questions\n\n",
  Checkpoint: "## Current State\n\n\n## Stable Context\n\n",
  Attachment: "## Source\n\n\n## Notes\n\n",
  Compile: "", // filled by compile logic
  Branch: "",
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

// Returns the entry row with the highest Number for this project (excluding Compile)
export async function getLatestEntry(thoughtId: string): Promise<NotionPage | null> {
  const response = await notion.dataSources.query({
    data_source_id: ENTRIES_DB_ID,
    filter: {
      and: [
        { property: "Project", relation: { contains: thoughtId } },
        { property: "Type", select: { does_not_equal: "Compile" } },
      ],
    },
    sorts: [
      {
        property: "Number",
        direction: "descending",
      },
    ],
    page_size: 1,
  });

  if (response.results.length === 0) return null;
  return response.results[0] as unknown as NotionPage;
}

// Returns max(Number) across non-Compile entries for this project
export async function getMaxNumber(thoughtId: string): Promise<number> {
  const latest = await getLatestEntry(thoughtId);
  return latest?.properties?.Number?.number ?? 0;
}

// Returns the number to assign to a new entry (always increments by one: max + 1)
export async function resolveNumber(
  thoughtId: string
): Promise<{ number: number; max: number }> {
  const max = await getMaxNumber(thoughtId);
  return {
    number: max + 1,
    max,
  };
}

export async function createEntry(params: {
  thoughtId: string;
  pageType: PageType;
}): Promise<{ pageId: string; number: number | null; continueBranch: boolean; max: number }> {
  const { thoughtId, pageType } = params;

  const isCompile = pageType === "Compile";

  let inheritedTitle = "";
  let inheritedIcon: NotionPage["icon"] = undefined;
  let continueBranch = false;
  let linkedBranchId: string | undefined = undefined;

  // Retrieve Continue Branch flag
  continueBranch = await getContinueBranch(thoughtId);
  debug(`continueBranch resolved from database:`, continueBranch);

  if (continueBranch) {
    // 1. Try to get branch from Project page properties
    try {
      const projectPage = await notion.pages.retrieve({ page_id: thoughtId });
      const p = projectPage as any;
      if (p.properties) {
        const branchProp = findProperty(p.properties, "Branch");
        const branchId = branchProp?.relation?.[0]?.id;
        if (branchId) {
          linkedBranchId = branchId;
          debug(`Found branch from Project: ${branchId}`);
        }
      }
    } catch (err) {
      warn(`Could not retrieve Project page ${thoughtId} to check for Branch:`, err);
    }

    // 2. If not found, try to get branch from the latest Entry for this project
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
    debug(`Creating new Branch "start" with icon ${randomEmoji}`);
    try {
      const newBranchPage = await notion.pages.create({
        parent: { data_source_id: BRANCH_DB_ID },
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
    } catch (createBranchErr) {
      logError("Failed to create start branch:", createBranchErr);
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

  // --- Number resolution ---
  let number: number | null = null;
  let max = 0;
  if (!isCompile && pageType !== "Branch") {
    const resolved = await resolveNumber(thoughtId);
    number = resolved.number;
    max = resolved.max;
  }
  debug(`Resolved number to assign:`, number, `(max was: ${max})`);

  // --- Build properties ---
  const properties: Record<string, unknown> = {
    Name: {
      title: [{ text: { content: inheritedTitle } }],
    },
    Type: { select: { name: pageType } },
    Include: { checkbox: true },
    Project: { relation: [{ id: thoughtId }] },
  };

  if (number !== null) {
    properties.Number = { number };
  }

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
    parent: { data_source_id: ENTRIES_DB_ID },
    properties,
    children:
      (!isCompile && pageType !== "Branch") ? markdownToNotionBlocks(TEMPLATES[pageType]) : [],
  };

  if (inheritedIcon) {
    createPayload.icon = inheritedIcon;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const page = await notion.pages.create(createPayload as any);
  return { pageId: page.id, number, continueBranch, max };
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
