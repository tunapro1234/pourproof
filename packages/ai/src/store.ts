// Recorded responses: one JSON file per request, named by its prompt_sha256. Without ANTHROPIC_API_KEY the package
// answers from these files and says so (mode "recorded"). A file written by hand before any live call carries
// recording "handwritten fixture"; `npm run record -w packages/ai` replaces it with what the model actually returned.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Task } from "./request.ts";

export const RECORDED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "recorded_responses");

export type Recording = "live call" | "handwritten fixture";

export interface RecordFile {
  format: "pourproof.ai-recording/1";
  prompt_sha256: string;
  task: Task;
  input: string;
  input_sha256: string | null;
  model: string;
  recording: Recording;
  note: string;
  stop_reason: string | null;
  output: unknown;
}

export class NoRecording extends Error {
  readonly prompt_sha256: string;
  readonly input: string;
  constructor(prompt_sha256: string, input: string) {
    super(
      `no recorded response for ${input} (prompt_sha256 ${prompt_sha256}); set ANTHROPIC_API_KEY and run npm run record -w packages/ai`,
    );
    this.name = "NoRecording";
    this.prompt_sha256 = prompt_sha256;
    this.input = input;
  }
}

export const recordPath = (dir: string, hash: string): string => join(dir, `${hash}.json`);

export function readRecord(dir: string, hash: string, input: string): RecordFile {
  const p = recordPath(dir, hash);
  if (!existsSync(p)) throw new NoRecording(hash, input);
  const r = JSON.parse(readFileSync(p, "utf8")) as RecordFile;
  if (r.prompt_sha256 !== hash) throw new Error(`${p}: prompt_sha256 inside the file does not match its name`);
  return r;
}

export function writeRecord(dir: string, r: RecordFile): string {
  mkdirSync(dir, { recursive: true });
  const p = recordPath(dir, r.prompt_sha256);
  writeFileSync(p, JSON.stringify(r, null, 1) + "\n");
  return p;
}
