import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";

export interface Config {
  apiUrl: string;
  region: string;
  clientId: string;
  collectorClientId: string;
}
export interface Session {
  idToken: string;
  refreshToken: string;
  exp: number;
  email: string;
  groups: string[];
  clientId: string; // refresh tokens only work with the client that issued them
}

let cfg: Config;
let cognito: CognitoIdentityProviderClient;
const KEY = "kc.session";

export async function loadConfig(): Promise<Config> {
  cfg = await (await fetch("/config.json", { cache: "no-store" })).json();
  cognito = new CognitoIdentityProviderClient({ region: cfg.region });
  return cfg;
}
export const apiUrl = () => cfg.apiUrl;

function parse(idToken: string, refreshToken: string, clientId: string): Session {
  const p = JSON.parse(atob(idToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
  const g = p["cognito:groups"];
  return { idToken, refreshToken, exp: p.exp * 1000, email: p.email, groups: Array.isArray(g) ? g : [], clientId };
}

// shortcut: tokens live in localStorage (XSS-exposed); move to httpOnly cookies behind a BFF if the app ever renders untrusted HTML.
function save(s: Session) {
  localStorage.setItem(KEY, JSON.stringify(s));
  return s;
}

export function current(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}

export function signOut() {
  localStorage.removeItem(KEY);
}

export async function signIn(email: string, password: string): Promise<Session> {
  const r = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: cfg.clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );
  const t = r.AuthenticationResult;
  if (!t?.IdToken || !t.RefreshToken) throw new Error("sign-in failed");
  return save(parse(t.IdToken, t.RefreshToken, cfg.clientId));
}

export async function signUp(email: string, password: string) {
  await cognito.send(
    new SignUpCommand({ ClientId: cfg.clientId, Username: email, Password: password, UserAttributes: [{ Name: "email", Value: email }] }),
  );
}

export async function confirmSignUp(email: string, code: string) {
  await cognito.send(new ConfirmSignUpCommand({ ClientId: cfg.clientId, Username: email, ConfirmationCode: code }));
}

/** A valid id token, refreshing it a minute before expiry. Signs out if the refresh token is rejected. */
export async function token(): Promise<string> {
  const s = current();
  if (!s) throw new Error("not signed in");
  if (s.exp - Date.now() > 60_000) return s.idToken;
  try {
    const r = await cognito.send(
      new InitiateAuthCommand({ AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: s.clientId ?? cfg.clientId, AuthParameters: { REFRESH_TOKEN: s.refreshToken } }),
    );
    const id = r.AuthenticationResult?.IdToken;
    if (!id) throw new Error("refresh failed");
    return save(parse(id, s.refreshToken, s.clientId ?? cfg.clientId)).idToken;
  } catch (e) {
    signOut();
    location.reload();
    throw e;
  }
}

/** Collector sign-in from the QR card: one custom-auth round trip with the one-time code. The code is single use. */
export async function signInWithCard(username: string, code: string): Promise<Session> {
  const start = await cognito.send(
    new InitiateAuthCommand({ AuthFlow: "CUSTOM_AUTH", ClientId: cfg.collectorClientId, AuthParameters: { USERNAME: username } }),
  );
  const done = await cognito.send(
    new RespondToAuthChallengeCommand({
      ClientId: cfg.collectorClientId,
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: start.Session,
      ChallengeResponses: { USERNAME: start.ChallengeParameters?.USERNAME ?? username, ANSWER: code },
    }),
  );
  const t = done.AuthenticationResult;
  if (!t?.IdToken || !t.RefreshToken) throw new Error("card rejected");
  return save(parse(t.IdToken, t.RefreshToken, cfg.collectorClientId));
}
