import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

const sns = new SNSClient({});

/** Publish an ops event; send an SMS only when SMS_ENABLED=true (needs India DLT registration). */
export async function notifyCollector(phone: string, text: string): Promise<void> {
  if (process.env.TOPIC_ARN) {
    await sns.send(new PublishCommand({ TopicArn: process.env.TOPIC_ARN, Message: JSON.stringify({ event: "batch_assigned" }) }));
  }
  if (process.env.SMS_ENABLED === "true") {
    await sns.send(new PublishCommand({ PhoneNumber: phone.startsWith("+") ? phone : `+91${phone}`, Message: text }));
  }
}
