// npm run export-ai -w apps/web
import { writeFileSync } from "node:fs";
import { AI_FILE, aiFileText } from "./ai-file.ts";

writeFileSync(AI_FILE, await aiFileText());
console.log(`wrote ${AI_FILE}`);
