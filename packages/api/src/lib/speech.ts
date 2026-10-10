import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { StartStreamTranscriptionCommand, TranscribeStreamingClient } from "@aws-sdk/client-transcribe-streaming";

/**
 * Hindi speech in/out. Bhashini (free, government) is tried first when its keys exist in SSM
 * (/kabadi/bhashini/userId and /apiKey); on any error or timeout we fall back to Transcribe / Polly.
 * Bhashini calls follow its public pipeline API and are untested until keys are added (task H14).
 */
const BHASHINI_CONFIG_URL = "https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline";
const BHASHINI_PIPELINE_ID = "64392f96daac500b55c543cd";
const TIMEOUT_MS = 3000;

export interface Transcript {
  text: string;
  provider: "bhashini" | "transcribe";
}
export interface Spoken {
  audio: string; // base64
  mime: string;
  provider: "bhashini" | "polly";
}

const ssm = new SSMClient({});
let creds: { at: number; value: { userId: string; apiKey: string } | null } | undefined;

async function bhashiniCreds() {
  if (creds && Date.now() - creds.at < 5 * 60_000) return creds.value;
  let value: { userId: string; apiKey: string } | null = null;
  try {
    const r = await ssm.send(
      new GetParametersCommand({ Names: ["/kabadi/bhashini/userId", "/kabadi/bhashini/apiKey"], WithDecryption: true }),
    );
    const get = (n: string) => r.Parameters?.find((p) => p.Name === n)?.Value;
    const userId = get("/kabadi/bhashini/userId");
    const apiKey = get("/kabadi/bhashini/apiKey");
    if (userId && apiKey) value = { userId, apiKey };
  } catch (e) {
    console.warn(JSON.stringify({ level: "warn", msg: "ssm read failed", reason: (e as Error).message }));
  }
  creds = { at: Date.now(), value };
  return value;
}

interface Pipeline {
  url: string;
  keyName: string;
  keyValue: string;
  serviceId: string;
}
const pipelines = new Map<string, Pipeline>();

async function bhashiniPipeline(task: "asr" | "tts", c: { userId: string; apiKey: string }): Promise<Pipeline> {
  const hit = pipelines.get(task);
  if (hit) return hit;
  const res = await fetch(BHASHINI_CONFIG_URL, {
    method: "POST",
    headers: { "content-type": "application/json", userID: c.userId, ulcaApiKey: c.apiKey },
    body: JSON.stringify({
      pipelineTasks: [{ taskType: task, config: { language: { sourceLanguage: "hi" } } }],
      pipelineRequestConfig: { pipelineId: BHASHINI_PIPELINE_ID },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS + 1000),
  });
  if (!res.ok) throw new Error(`bhashini config ${res.status}`);
  const j: any = await res.json();
  const ep = j.pipelineInferenceAPIEndPoint;
  const p: Pipeline = {
    url: ep.callbackUrl,
    keyName: ep.inferenceApiKey.name,
    keyValue: ep.inferenceApiKey.value,
    serviceId: j.pipelineResponseConfig[0].config[0].serviceId,
  };
  pipelines.set(task, p);
  return p;
}

async function bhashiniCompute(p: Pipeline, task: unknown, inputData: unknown): Promise<any> {
  const res = await fetch(p.url, {
    method: "POST",
    headers: { "content-type": "application/json", [p.keyName]: p.keyValue },
    body: JSON.stringify({ pipelineTasks: [task], inputData }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    pipelines.clear(); // service ids rotate; refetch next time
    throw new Error(`bhashini compute ${res.status}`);
  }
  return res.json();
}

/** Offset of the PCM data in a WAV file (the browser sends a plain 16 kHz mono 16-bit WAV). */
export function pcmOf(wav: Buffer): Buffer {
  const at = wav.indexOf("data");
  if (wav.subarray(0, 4).toString() !== "RIFF" || at < 0) throw new Error("not a wav file");
  return wav.subarray(at + 8);
}

async function awsTranscribe(wav: Buffer): Promise<string> {
  const pcm = pcmOf(wav);
  async function* chunks() {
    for (let i = 0; i < pcm.length; i += 8192) yield { AudioEvent: { AudioChunk: pcm.subarray(i, i + 8192) } };
  }
  const res = await new TranscribeStreamingClient({}).send(
    new StartStreamTranscriptionCommand({ LanguageCode: "hi-IN", MediaEncoding: "pcm", MediaSampleRateHertz: 16000, AudioStream: chunks() }),
  );
  let text = "";
  for await (const ev of res.TranscriptResultStream ?? []) {
    for (const r of ev.TranscriptEvent?.Transcript?.Results ?? []) {
      if (!r.IsPartial) text += `${r.Alternatives?.[0]?.Transcript ?? ""} `;
    }
  }
  return text.trim();
}

export async function transcribe(wav: Buffer): Promise<Transcript> {
  const c = await bhashiniCreds();
  if (c) {
    try {
      const p = await bhashiniPipeline("asr", c);
      const j = await bhashiniCompute(
        p,
        { taskType: "asr", config: { language: { sourceLanguage: "hi" }, serviceId: p.serviceId, audioFormat: "wav", samplingRate: 16000 } },
        { audio: [{ audioContent: wav.toString("base64") }] },
      );
      const text = String(j.pipelineResponse?.[0]?.output?.[0]?.source ?? "").trim();
      if (text) return { text, provider: "bhashini" };
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "bhashini asr failed, using transcribe", reason: (e as Error).message }));
    }
  }
  return { text: await awsTranscribe(wav), provider: "transcribe" };
}

export async function synthesize(text: string): Promise<Spoken> {
  const c = await bhashiniCreds();
  if (c) {
    try {
      const p = await bhashiniPipeline("tts", c);
      const j = await bhashiniCompute(
        p,
        { taskType: "tts", config: { language: { sourceLanguage: "hi" }, serviceId: p.serviceId, gender: "female" } },
        { input: [{ source: text }] },
      );
      const audio = j.pipelineResponse?.[0]?.audio?.[0]?.audioContent;
      if (audio) return { audio, mime: "audio/wav", provider: "bhashini" };
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "bhashini tts failed, using polly", reason: (e as Error).message }));
    }
  }
  const r = await new PollyClient({}).send(
    new SynthesizeSpeechCommand({ Text: text, VoiceId: "Kajal", Engine: "neural", LanguageCode: "hi-IN", OutputFormat: "mp3" }),
  );
  const bytes = await r.AudioStream!.transformToByteArray();
  return { audio: Buffer.from(bytes).toString("base64"), mime: "audio/mpeg", provider: "polly" };
}
