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

export async function getNextNumber(thoughtId: string): Promise<number> {
  // Query all Entries for this project where Type != Compile
  // SDK v5: notion.databases.query → notion.dataSources.query({ data_source_id })
  const response = await notion.dataSources.query({
    data_source_id: ENTRIES_DB_ID,
    filter: {
      and: [
        {
          property: "Thought Management",
          relation: { contains: thoughtId },
        },
        {
          property: "Type",
          select: { does_not_equal: "Compile" },
        },
      ],
    },
  });

  let max = 0;
  for (const page of response.results) {
    if (page.object !== "page") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = page as any;
    const num = p.properties?.Number?.number ?? 0;
    if (num > max) max = num;
  }
  return max + 1;
}

export async function createEntry(params: {
  thoughtId: string;
  pageType: PageType;
}): Promise<string> {
  const { thoughtId, pageType } = params;

  const isCompile = pageType === "Compile";
  const number = isCompile ? null : await getNextNumber(thoughtId);

  // Build page properties
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const properties: any = {
    Title: { title: [{ text: { content: "" } }] },
    Type: { select: { name: pageType } },
    Include: { checkbox: true },
    "Thought Management": { relation: [{ id: thoughtId }] },
  };

  if (number !== null) {
    properties.Number = { number };
  }

  // SDK v5: parent.database_id → parent.data_source_id
  const page = await notion.pages.create({
    parent: { data_source_id: ENTRIES_DB_ID },
    properties,
    children:
      pageType !== "Compile" ? markdownToNotionBlocks(TEMPLATES[pageType]) : [],
  });

  return page.id;
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
