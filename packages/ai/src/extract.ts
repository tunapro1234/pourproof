// Field extraction from a delivery ticket photo and an EPD PDF. Claude reads the document; code then checks every
// field (verify.ts) and a person approves. Nothing extracted here is written on chain without that approval.
import { attach, build, type BuiltRequest } from "./request.ts";
import { run, type AiMeta, type RunOptions } from "./run.ts";
import { checkImageField, checkPdfField, pdfPages, type Field, type FieldStatus, type RawField } from "./verify.ts";

export const TICKET_FIELDS = {
  ticket_number: "the delivery ticket number",
  supplier: "the supplier name as printed",
  date: "the delivery date",
  truck_plate: "the truck plate",
  pour_id: "the pour identifier",
  mix_code: "the mix code",
  cement_type: "the cement type",
  cement_content: "the cement content per m3",
  volume: "the delivered volume",
  loaded_at: "the time the truck was loaded at the plant",
  arrived_at: "the time the truck arrived on site",
  discharge_start: "the time discharge started",
} as const;

export const EPD_FIELDS = {
  document_number: "the EPD document number",
  declared_by: "who declares the EPD",
  mix_code: "the mix code of the product",
  cement: "the cement type",
  cement_content: "the cement content per m3",
  declared_unit: "the declared unit",
  modules: "the life cycle modules covered (for example A1-A3)",
  gwp_total_low: "the lower bound of GWP-total for the declared unit",
  gwp_total_high: "the upper bound of GWP-total for the declared unit",
  verification: "the verification or status statement of the document",
} as const;

export type TicketField = keyof typeof TICKET_FIELDS;
export type EpdField = keyof typeof EPD_FIELDS;

// value and unit are plain strings, "" when absent: the API allows at most 16 union-typed (nullable) parameters per
// schema, and an EPD asks for 12 fields. raw() maps "" back to null.
const fieldSchema = {
  type: "object",
  properties: { value: { type: "string" }, unit: { type: "string" }, page: { type: "integer" }, quote: { type: "string" } },
  required: ["value", "unit", "page", "quote"],
  additionalProperties: false,
};

export function schemaFor(fields: Record<string, string>): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(Object.keys(fields).map((k) => [k, fieldSchema])),
    required: Object.keys(fields),
    additionalProperties: false,
  };
}

export const EXTRACT_SYSTEM = [
  "You read paperwork for a concrete pour so that a site inspector can check it quickly.",
  "For each requested field, return:",
  "- value: the text exactly as printed on the document, character for character. Do not convert units, reformat dates or numbers, or fill in anything that is not printed. A range such as \"390 to 411\" is two fields (lower and upper bound) when asked that way; each value is then one number as printed.",
  "- unit: the unit printed next to the value (for example \"m3\" or \"kg CO2e/m3\"), or an empty string if there is none.",
  "- page: the 1-based page number where you read it (1 for a photo).",
  "- quote: one line of text from that page, copied exactly, that contains the value. Prefer the shortest complete line or table row. Do not join text from different lines.",
  "If a field is not on the document, return an empty value, an empty unit, page 1 and an empty quote. Never guess.",
  "Your output is checked by software against the document's text and then approved or rejected by a person.",
].join("\n");

function fieldList(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, d]) => `- ${k}: ${d}`)
    .join("\n");
}

export function ticketRequest(imagePath: string): BuiltRequest {
  return build("extractTicket", EXTRACT_SYSTEM, `This is a photo of a ready-mixed concrete delivery ticket. Extract these fields:\n${fieldList(TICKET_FIELDS)}`, schemaFor(TICKET_FIELDS), attach(imagePath));
}

export function epdRequest(pdfPath: string): BuiltRequest {
  return build("extractEpd", EXTRACT_SYSTEM, `This is an Environmental Product Declaration (EPD) for ready-mixed concrete. Extract these fields:\n${fieldList(EPD_FIELDS)}`, schemaFor(EPD_FIELDS), attach(pdfPath));
}

export interface Extraction<K extends string> extends AiMeta {
  task: "extractTicket" | "extractEpd";
  document: string;
  document_sha256: string;
  fields: Record<K, Field>;
  counts: Record<FieldStatus, number>;
}

function raw(output: unknown, key: string): RawField {
  const f = (output as Record<string, Partial<RawField>> | null)?.[key];
  return { value: f?.value || null, unit: f?.unit || null, page: typeof f?.page === "number" ? f.page : 0, quote: typeof f?.quote === "string" ? f.quote : "" };
}

function finish<K extends string>(req: BuiltRequest, meta: AiMeta, keys: readonly K[], check: (f: RawField) => Field, output: unknown): Extraction<K> {
  const fields = Object.fromEntries(keys.map((k) => [k, check(raw(output, k))])) as Record<K, Field>;
  const counts: Record<FieldStatus, number> = { verified: 0, needs_review: 0, unverified: 0 };
  for (const f of Object.values<Field>(fields)) counts[f.status]++;
  return { ...meta, task: req.task as "extractTicket" | "extractEpd", document: req.attachment!.path, document_sha256: req.attachment!.sha256, fields, counts };
}

/** Fields of a delivery ticket photo (PNG). Each field is "needs_review" or "unverified"; a person confirms it. */
export async function extractTicket(imagePath: string, o: RunOptions = {}): Promise<Extraction<TicketField>> {
  const req = ticketRequest(imagePath);
  const { meta, output } = await run(req, o);
  return finish(req, meta, Object.keys(TICKET_FIELDS) as TicketField[], checkImageField, output);
}

/** Fields of an EPD PDF. A field is "verified" only if its quote is on the cited page and holds the value. */
export async function extractEpd(pdfPath: string, o: RunOptions = {}): Promise<Extraction<EpdField>> {
  const req = epdRequest(pdfPath);
  const { meta, output } = await run(req, o);
  const pages = pdfPages(pdfPath);
  return finish(req, meta, Object.keys(EPD_FIELDS) as EpdField[], (f) => checkPdfField(f, pages), output);
}
