import { createHash } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type {
  CreateAuthChallengeTriggerEvent,
  DefineAuthChallengeTriggerEvent,
  VerifyAuthChallengeResponseTriggerEvent,
} from "aws-lambda";
import { ddb, TABLE } from "../lib/ddb.js";

/**
 * Passwordless sign-in for collectors: the admin prints a QR card holding a one-time code.
 * The code's hash lives on the collector's COL#<sub> item (enrollHash/enrollExp), so issuing a new
 * card replaces the old one and revoking removes it.
 */
export const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

const MAX_ATTEMPTS = 3;

export const define = async (e: DefineAuthChallengeTriggerEvent): Promise<DefineAuthChallengeTriggerEvent> => {
  const s = e.request.session;
  const last = s[s.length - 1];
  if (last?.challengeName === "CUSTOM_CHALLENGE" && last.challengeResult) {
    e.response.issueTokens = true;
    e.response.failAuthentication = false;
  } else if (s.length >= MAX_ATTEMPTS) {
    e.response.issueTokens = false;
    e.response.failAuthentication = true;
  } else {
    e.response.issueTokens = false;
    e.response.failAuthentication = false;
    e.response.challengeName = "CUSTOM_CHALLENGE";
  }
  return e;
};

export const create = async (e: CreateAuthChallengeTriggerEvent): Promise<CreateAuthChallengeTriggerEvent> => {
  // Nothing to send: the code is already on the card.
  e.response.publicChallengeParameters = { type: "enroll-code" };
  e.response.privateChallengeParameters = {};
  return e;
};

export const verify = async (e: VerifyAuthChallengeResponseTriggerEvent): Promise<VerifyAuthChallengeResponseTriggerEvent> => {
  e.response.answerCorrect = false;
  const answer = String(e.request.challengeAnswer ?? "");
  const sub = e.request.userAttributes.sub;
  if (!answer || !sub) return e;
  const key = { PK: `COL#${sub}`, SK: "META" };
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: key }));
  const hash = hashCode(answer);
  if (!Item?.enrollHash || Item.enrollHash !== hash || Item.enrollExp < Date.now()) return e;
  try {
    // Single use: only the first caller to clear the hash wins.
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE(),
        Key: key,
        UpdateExpression: "REMOVE enrollHash, enrollExp",
        ConditionExpression: "enrollHash = :h",
        ExpressionAttributeValues: { ":h": hash },
      }),
    );
    e.response.answerCorrect = true;
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
  return e;
};
