import { BedrockRuntimeClient, ConverseCommand, type ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({});
// India-resident inference profile: prompts and images stay in India.
export const MODEL = () => process.env.BEDROCK_MODEL ?? "in.anthropic.claude-haiku-4-5-20251001-v1:0";

export interface ToolCall {
  name: string;
  input: Record<string, any>;
}

/** One Converse call that must end in a tool call; returns it, or null if the model answered in prose. */
export async function toolCall(input: Omit<ConverseCommandInput, "modelId">): Promise<ToolCall | null> {
  const res = await client.send(new ConverseCommand({ modelId: MODEL(), ...input }));
  const block = res.output?.message?.content?.find((b) => b.toolUse);
  return block?.toolUse ? { name: block.toolUse.name!, input: (block.toolUse.input ?? {}) as Record<string, any> } : null;
}
