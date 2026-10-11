import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});
const cache = new Map<string, { at: number; value: string | null }>();

/** An SSM SecureString, cached for 5 minutes; null when the parameter does not exist (feature simply stays off). */
export async function secret(name: string): Promise<string | null> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  let value: string | null = null;
  try {
    value = (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value ?? null;
  } catch (e) {
    if ((e as Error).name !== "ParameterNotFound") console.warn(JSON.stringify({ level: "warn", msg: "ssm read failed", name, reason: (e as Error).message }));
  }
  cache.set(name, { at: Date.now(), value });
  return value;
}
