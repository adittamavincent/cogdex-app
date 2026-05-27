import { notion } from "./notion";
import { PageType } from "./types";

const ENTRIES_DB_ID = process.env.NOTION_ENTRIES_DB_ID!;

// Page body templates per Type
const TEMPLATES: Record<PageType, string> = {
  User: "## Intent\n\n\n## Brain Dump\n\n",
  Response: "## LLM Response\n\n",
  Agreement: "## Decisions\n\n\n## Definitions\n\n\n## Open Questions\n\n",
  Checkpoint: "## Current State\n\n\n## Stable Context\n\n",
  Attachment: "## Source\n\n\n## Notes\n\n",
  Compile: "", // filled by compile logic
};

// Read Continue Branch flag from a Thought Management page
export async function getContinueBranch(thoughtId: string): Promise<boolean> {
  const page = await notion.pages.retrieve({ page_id: thoughtId });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = page as any;
  if (!p.properties) {
    console.error("[Cogdex] No properties found on Thought Management page response:", p);
    return false;
  }

  // Find key case-insensitively and stripping whitespace
  const targetKey = "continuebranch";
  const matchedKey = Object.keys(p.properties).find(
    (k) => k.toLowerCase().replace(/\s+/g, "") === targetKey
  );

  if (!matchedKey) {
    console.warn(
      `[Cogdex] "Continue Branch" property not found on Thought Management page. Available properties:`,
      Object.keys(p.properties)
    );
    return false;
  }

  const isChecked = p.properties[matchedKey]?.checkbox ?? false;
  console.log(`[Cogdex] Found property "${matchedKey}", value is:`, isChecked);
  return isChecked;
}


// Returns the entry row with the highest Number for this project (excluding Compile)
export async function getLatestEntry(thoughtId: string): Promise<any | null> {
  const response = await notion.dataSources.query({
    data_source_id: ENTRIES_DB_ID,
    filter: {
      and: [
        { property: "Thought Management", relation: { contains: thoughtId } },
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
  return response.results[0];
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

  // --- Continue Branch logic ---
  let inheritedTitle = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inheritedIcon: any = undefined;
  let continueBranch = false;

  continueBranch = await getContinueBranch(thoughtId);
  console.log(`[Cogdex] continueBranch resolved from database:`, continueBranch);

  if (continueBranch) {
    const latest = await getLatestEntry(thoughtId);
    if (latest) {
      // Copy title
      inheritedTitle =
        latest.properties?.Title?.title?.[0]?.plain_text ?? "";

      // Copy icon (emoji or external URL)
      if (latest.icon) {
        inheritedIcon = latest.icon; // pass through as-is to pages.create
      }
      console.log(`[Cogdex] Inheriting from latest entry: title="${inheritedTitle}", icon=`, inheritedIcon);
    } else {
      console.log(`[Cogdex] No latest entry found to inherit from.`);
    }
  }

  // --- Number resolution ---
  let number: number | null = null;
  let max = 0;
  if (!isCompile) {
    const resolved = await resolveNumber(thoughtId);
    number = resolved.number;
    max = resolved.max;
  }
  console.log(`[Cogdex] Resolved number to assign:`, number, `(max was: ${max})`);


  // --- Build properties ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const properties: any = {
    Title: {
      title: [{ text: { content: inheritedTitle } }],
    },
    Type: { select: { name: pageType } },
    Include: { checkbox: true },
    "Thought Management": { relation: [{ id: thoughtId }] },
  };

  if (number !== null) {
    properties.Number = { number };
  }

  // --- Build pages.create payload ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createPayload: any = {
    parent: { data_source_id: ENTRIES_DB_ID },
    properties,
    children:
      !isCompile ? markdownToNotionBlocks(TEMPLATES[pageType]) : [],
  };

  if (inheritedIcon) {
    createPayload.icon = inheritedIcon;
  }

  const page = await notion.pages.create(createPayload);
  return { pageId: page.id, number, continueBranch, max };
}


// Minimal markdown-to-Notion-blocks converter for templates.
// Only handles headings (##) and paragraphs — intentionally minimal.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function markdownToNotionBlocks(md: string): any[] {
  const lines = md.split("\n");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [];

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
