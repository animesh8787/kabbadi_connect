import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { ZodError, type ZodTypeAny, type z } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Ctx {
  sub: string;
  groups: string[];
  event: APIGatewayProxyEvent;
  param: (k: string) => string;
  body: <T extends ZodTypeAny>(schema: T) => z.infer<T>;
}

const headers = {
  "content-type": "application/json",
  "access-control-allow-origin": process.env.ALLOW_ORIGIN ?? "*",
};

/** Cognito groups arrive as "a,b" or "[a b]" depending on the authorizer. */
export const parseGroups = (raw: unknown): string[] =>
  typeof raw === "string" ? raw.split(/[^\w-]+/).filter(Boolean) : Array.isArray(raw) ? raw.map(String) : [];

export function json(status: number, data: unknown): APIGatewayProxyResult {
  return { statusCode: status, headers, body: JSON.stringify(data) };
}

/** Wrap a handler: auth claims, group guard, zod validation, uniform errors. PII is never logged. */
export function route(groups: string[] | null, fn: (c: Ctx) => Promise<unknown>) {
  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
      const claims = (event.requestContext.authorizer?.claims ?? {}) as Record<string, unknown>;
      const sub = String(claims.sub ?? "");
      if (!sub) throw new HttpError(401, "unauthenticated");
      const g = parseGroups(claims["cognito:groups"]);
      if (groups && !groups.some((x) => g.includes(x))) throw new HttpError(403, "forbidden");
      const ctx: Ctx = {
        sub,
        groups: g,
        event,
        param: (k) => event.pathParameters?.[k] ?? "",
        body: (schema) => {
          let raw: unknown;
          try {
            raw = JSON.parse(event.body ?? "{}");
          } catch {
            throw new HttpError(400, "invalid json");
          }
          return schema.parse(raw);
        },
      };
      const out = await fn(ctx);
      return json(200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      if (e instanceof ZodError) {
        return json(400, { error: "invalid input", issues: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      }
      console.error(JSON.stringify({ level: "error", msg: (e as Error).message, name: (e as Error).name }));
      return json(500, { error: "internal error" });
    }
  };
}
