export type PageType =
  | "User"
  | "Response"
  | "Agreement"
  | "Checkpoint"
  | "Attachment"
  | "Compile";

// Body sent by Notion webhook content — contains the current row's page ID
export interface CogdexWebhookPayload {
  thoughtId: string; // ID of the Thought Management page (from Notion content variable)
}
