import { DetectLabelsCommand, RekognitionClient } from "@aws-sdk/client-rekognition";
import type { Category } from "@kc/shared";

/** Backup for photo fill when the language model is unavailable: map Rekognition labels to our five materials. */
const MAP: Record<Category, string[]> = {
  paper: ["paper", "newspaper", "cardboard", "carton", "box", "book", "document", "file", "magazine", "paper towel", "envelope"],
  plastic: ["plastic", "bottle", "plastic bag", "bag", "container", "bucket", "jug", "cup", "water bottle", "bin"],
  metal: ["tin", "can", "aluminium", "aluminum", "metal", "steel", "iron", "scrap", "pot", "pan", "utensil"],
  ewaste: ["electronics", "computer", "laptop", "phone", "mobile phone", "cell phone", "cable", "wire", "battery", "monitor", "keyboard", "hardware", "adapter", "remote control", "television"],
  glass: ["glass", "jar", "wine bottle", "glass bottle", "beverage"],
};
const BY_LABEL = new Map(Object.entries(MAP).flatMap(([cat, names]) => names.map((n) => [n, cat as Category] as const)));

export function itemsFromLabels(labels: { Name?: string; Parents?: { Name?: string }[] }[]) {
  const found = new Set<Category>();
  for (const l of labels) {
    for (const n of [l.Name, ...(l.Parents ?? []).map((p) => p.Name)]) {
      const cat = n && BY_LABEL.get(n.toLowerCase());
      if (cat) found.add(cat);
    }
  }
  // Weight is not visible in a label: default bucket, the household edits it.
  return [...found].map((cat) => ({ cat, bucket: "2-5" as const }));
}

export async function labelItems(bytes: Uint8Array) {
  const r = await new RekognitionClient({}).send(new DetectLabelsCommand({ Image: { Bytes: bytes }, MaxLabels: 25, MinConfidence: 60 }));
  return itemsFromLabels(r.Labels ?? []);
}
