export type PageType =
  | "CHAT USER"
  | "CHAT RESP"
  | "MEMO EXPO"
  | "MEMO RESP"
  | "CHAT EXPO"
  | "CHAT CMNT"
  | "SYST LINK"
  | "MEMO UPDT"
  | "REPO SNAP"
  | "TASK EXPO"
  | "TASK RESP";

// Notion automation webhook — actual payload shape sent by Notion
// body.data.id is the page ID of the Thought Management row that triggered the button
export interface NotionAutomationPayload {
  source: {
    type: string;
    automation_id: string;
    action_id: string;
    event_id: string;
    user_id: string;
    attempt: number;
  };
  data: {
    object: string;
    id: string; // Thought Management page ID — used as thoughtId
    [key: string]: unknown;
  };
}
