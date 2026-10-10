import { AdminAddUserToGroupCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import type { PostConfirmationTriggerEvent } from "aws-lambda";

const cognito = new CognitoIdentityProviderClient({});

/** Every self-signup becomes a household; collectors and admins are promoted by an admin out of band. */
export const handler = async (event: PostConfirmationTriggerEvent): Promise<PostConfirmationTriggerEvent> => {
  if (event.triggerSource === "PostConfirmation_ConfirmSignUp") {
    await cognito.send(
      new AdminAddUserToGroupCommand({ UserPoolId: event.userPoolId, Username: event.userName, GroupName: "household" }),
    );
  }
  return event;
};
