import { toolCall, type ToolCall } from "./bedrock.js";
import { secret } from "./secrets.js";

/**
 * One place that turns "what the person said + what we know" into a tool call.
 * Order: Amazon Bedrock (once the account is verified) -> Groq free tier -> none (callers use keyword rules).
 */
export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}
export interface Chosen {
  call: ToolCall | null;
  via: "bedrock" | "groq" | "none";
}

const EMPTY = { type: "object", properties: {} };
export const tool = (name: string, description: string, schema: Record<string, unknown> = EMPTY): ToolDef => ({ name, description, schema });

// A Bedrock access error will not fix itself within minutes: skip it for a while instead of paying its latency on every turn.
let bedrockDownUntil = 0;

async function viaBedrock(o: { system: string; user: string; tools: ToolDef[]; maxTokens: number }): Promise<ToolCall | null> {
  return toolCall({
    system: [{ text: o.system }],
    messages: [{ role: "user", content: [{ text: o.user }] }],
    toolConfig: { tools: o.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.schema } } })), toolChoice: { any: {} } } as any,
    inferenceConfig: { maxTokens: o.maxTokens, temperature: 0 },
  });
}

async function viaGroq(o: { system: string; user: string; tools: ToolDef[]; maxTokens: number; smart: boolean }): Promise<ToolCall | null> {
  const key = await secret("/kabadi/groq/apiKey");
  if (!key) return null;
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      // Groq retires models over time; these were the tool-capable ones on the free tier when last checked (see GET /openai/v1/models).
      model: o.smart ? "openai/gpt-oss-120b" : "openai/gpt-oss-20b",
      temperature: 0,
      reasoning_effort: "low",
      // reasoning tokens count towards the limit, so leave room beyond the short tool call
      max_tokens: Math.max(o.maxTokens, 1200),
      tool_choice: "required",
      messages: [
        { role: "system", content: o.system },
        { role: "user", content: o.user },
      ],
      tools: o.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })),
    }),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`groq ${res.status}`);
  const j: any = await res.json();
  const c = j.choices?.[0]?.message?.tool_calls?.[0]?.function;
  if (!c?.name) return null;
  let input: Record<string, any> = {};
  try {
    input = JSON.parse(c.arguments || "{}");
  } catch {
    /* malformed arguments: treat as a call with no input, planners validate */
  }
  return { name: c.name, input };
}

/** `smart` picks the larger Groq model for open questions; intent-only turns use the fast one. */
export async function chooseTool(o: { system: string; user: string; tools: ToolDef[]; smart?: boolean; maxTokens?: number }): Promise<Chosen> {
  const maxTokens = o.maxTokens ?? 500;
  if (Date.now() > bedrockDownUntil) {
    try {
      return { call: await viaBedrock({ ...o, maxTokens }), via: "bedrock" };
    } catch (e) {
      const msg = (e as Error).message;
      if (/verif|AccessDenied|not authorized/i.test(msg)) bedrockDownUntil = Date.now() + 5 * 60_000;
      console.warn(JSON.stringify({ level: "warn", msg: "bedrock unavailable", reason: msg.slice(0, 120) }));
    }
  }
  try {
    const call = await viaGroq({ ...o, maxTokens, smart: !!o.smart });
    if (call) return { call, via: "groq" };
  } catch (e) {
    console.warn(JSON.stringify({ level: "warn", msg: "groq failed", reason: (e as Error).message }));
  }
  return { call: null, via: "none" };
}

/** For tests: forget that Bedrock was marked down. */
export const resetLlmState = () => {
  bedrockDownUntil = 0;
};
