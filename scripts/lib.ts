import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CognitoIdentityProviderClient, InitiateAuthCommand, RespondToAuthChallengeCommand } from "@aws-sdk/client-cognito-identity-provider";

export const region = process.env.AWS_REGION ?? "ap-south-1";
export const stack = process.env.STACK ?? "kabadi-connect";
export const CREDS = ".seed-credentials.json";

export function outputs(): Record<string, string> {
  const raw = execFileSync(
    "aws",
    ["cloudformation", "describe-stacks", "--stack-name", stack, "--region", region, "--query", "Stacks[0].Outputs", "--output", "json"],
    { encoding: "utf8" },
  );
  return Object.fromEntries((JSON.parse(raw) as { OutputKey: string; OutputValue: string }[]).map((o) => [o.OutputKey, o.OutputValue]));
}

export interface Cred {
  email: string;
  password: string;
  sub: string;
  role: "admin" | "collector" | "household";
}
export const readCreds = (): Cred[] => (existsSync(CREDS) ? JSON.parse(readFileSync(CREDS, "utf8")) : []);
export const writeCreds = (c: Cred[]) => writeFileSync(CREDS, JSON.stringify(c, null, 2));

export async function signIn(clientId: string, email: string, password: string): Promise<string> {
  const r = await new CognitoIdentityProviderClient({ region }).send(
    new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: clientId, AuthParameters: { USERNAME: email, PASSWORD: password } }),
  );
  return r.AuthenticationResult!.IdToken!;
}

export async function call<T = any>(base: string, method: string, path: string, token: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

/** QR-card sign-in as the web app does it. Throws if the code is wrong, expired or already used. */
export async function cardSignIn(clientId: string, username: string, code: string): Promise<string> {
  const c = new CognitoIdentityProviderClient({ region });
  const start = await c.send(new InitiateAuthCommand({ AuthFlow: "CUSTOM_AUTH", ClientId: clientId, AuthParameters: { USERNAME: username } }));
  const done = await c.send(
    new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: start.Session,
      ChallengeResponses: { USERNAME: start.ChallengeParameters?.USERNAME ?? username, ANSWER: code },
    }),
  );
  if (!done.AuthenticationResult?.IdToken) throw new Error("card rejected");
  return done.AuthenticationResult.IdToken;
}

/** Sign in with a password on a given app client (collectors who read use this with their phone number). */
export async function passwordSignIn(clientId: string, username: string, password: string): Promise<string> {
  const r = await new CognitoIdentityProviderClient({ region }).send(
    new InitiateAuthCommand({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: clientId, AuthParameters: { USERNAME: username, PASSWORD: password } }),
  );
  return r.AuthenticationResult!.IdToken!;
}
