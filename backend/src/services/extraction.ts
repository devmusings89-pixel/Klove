// Turn a raw HealthDocument into a normalized ExtractedBundle.
// - images / PDFs → Claude vision + forced tool-use (extract_health_data)
// - email / text   → Claude text + the same tool (with a cheap is-health-related gate)
// In mock mode (no ANTHROPIC_API_KEY) returns deterministic sample data so the pipeline runs.

import Anthropic from "@anthropic-ai/sdk";
import type { HealthDocument } from "@prisma/client";
import { runTool, llmAvailable } from "./llm-tool.js";
import { getObject } from "./storage.js";
import type { ExtractedBundle } from "./fhir-map.js";

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "extract_health_data",
  description:
    "Extract structured clinical data from a medical document (lab report, after-visit summary, prescription, etc.). " +
    "Set isHealthRelated=false if the document contains no health information. Use null for unknown fields; " +
    "include a 0-1 confidence per item. Prefer standard codes (LOINC for labs, ICD-10 for conditions) when evident.",
  input_schema: {
    type: "object",
    properties: {
      isHealthRelated: { type: "boolean" },
      reportSummary: { type: "string" },
      reports: {
        type: "array",
        items: {
          type: "object",
          properties: {
            display: { type: "string" },
            category: { type: "string" },
            issuedAt: { type: "string", description: "ISO date" },
            confidence: { type: "number" },
          },
          required: ["display"],
        },
      },
      observations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string", description: "LOINC if known" },
            display: { type: "string" },
            valueNum: { type: "number" },
            valueString: { type: "string" },
            unit: { type: "string" },
            referenceRange: { type: "string" },
            abnormalFlag: { type: "string", description: "H, L, A, or omit" },
            effectiveAt: { type: "string", description: "ISO date" },
            confidence: { type: "number" },
          },
          required: ["display"],
        },
      },
      conditions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string", description: "ICD-10/SNOMED if known" },
            display: { type: "string" },
            clinicalStatus: { type: "string" },
            onsetDate: { type: "string" },
            severity: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["display"],
        },
      },
      medications: {
        type: "array",
        items: {
          type: "object",
          properties: {
            display: { type: "string" },
            dosage: { type: "string" },
            status: { type: "string" },
            startDate: { type: "string" },
            endDate: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["display"],
        },
      },
      allergies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            substance: { type: "string" },
            reaction: { type: "string" },
            severity: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["substance"],
        },
      },
      appointments: {
        type: "array",
        description: "Upcoming or past visits mentioned (confirmations, reminders, scheduling emails).",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "e.g. 'Cardiology follow-up'" },
            provider: { type: "string", description: "doctor or clinic name" },
            providerPhone: { type: "string", description: "office phone number if present in the document" },
            providerWebsite: { type: "string", description: "office/booking website if present" },
            providerAddress: { type: "string", description: "office street address if present" },
            location: { type: "string" },
            startsAt: { type: "string", description: "ISO 8601 date-time if known" },
            endsAt: { type: "string", description: "ISO 8601 date-time if known" },
            status: { type: "string", description: "scheduled | completed | cancelled" },
            confirmation: { type: "string" },
            notes: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["title"],
        },
      },
    },
    required: ["isHealthRelated"],
  },
};

const SYSTEM =
  "You are a clinical-document extraction engine for a personal health app. Extract only what is present; " +
  "never invent values. Be conservative with confidence. Output strictly via the extract_health_data tool.";

/** Extract a normalized bundle from a document's stored bytes. */
export async function extractDocument(doc: HealthDocument): Promise<ExtractedBundle> {
  if (!llmAvailable()) return mockBundle(doc);
  if (!doc.storagePath) throw new Error(`document ${doc.id} has no storagePath`);

  const bytes = await getObject(doc.storagePath);
  const content = buildContent(doc.mimeType, bytes);

  const result = await runTool<ExtractedBundle>({
    system: SYSTEM,
    content,
    tool: { name: EXTRACT_TOOL.name, description: EXTRACT_TOOL.description ?? "", input_schema: EXTRACT_TOOL.input_schema as Record<string, unknown> },
    maxTokens: 4000,
  });
  return result ?? { isHealthRelated: false };
}

/** Build the Claude message content for the document's media type. */
function buildContent(mimeType: string, bytes: Buffer): Anthropic.ContentBlockParam[] {
  const prompt = "Extract all clinical data from this document.";
  if (mimeType.startsWith("image/")) {
    return [
      {
        type: "image",
        source: { type: "base64", media_type: mimeType as Anthropic.Base64ImageSource["media_type"], data: bytes.toString("base64") },
      },
      { type: "text", text: prompt },
    ];
  }
  if (mimeType === "application/pdf") {
    return [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } },
      { type: "text", text: prompt },
    ];
  }
  // Plain text / email body.
  return [{ type: "text", text: `${prompt}\n\n---\n${bytes.toString("utf8").slice(0, 50_000)}` }];
}

/** Deterministic sample so the upload→extract→store→analyze pipeline is exercisable without keys. */
function mockBundle(doc: HealthDocument): ExtractedBundle {
  return {
    isHealthRelated: true,
    reportSummary: `[mock extraction] ${doc.originalName ?? doc.sourceType} document`,
    reports: [{ display: "Comprehensive Metabolic Panel", category: "laboratory", confidence: 0.9 }],
    observations: [
      { code: "4548-4", display: "Hemoglobin A1c", valueNum: 6.4, unit: "%", referenceRange: "4.0-5.6", abnormalFlag: "H", confidence: 0.9 },
      { code: "2339-0", display: "Glucose", valueNum: 142, unit: "mg/dL", referenceRange: "70-99", abnormalFlag: "H", confidence: 0.9 },
    ],
    conditions: [{ code: "E11.9", display: "Type 2 diabetes mellitus", clinicalStatus: "active", confidence: 0.7 }],
    appointments: [
      {
        title: "Endocrinology follow-up",
        provider: "Dr. Lin, City Endocrinology",
        location: "500 Main St, Suite 210",
        startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(),
        status: "scheduled",
        confidence: 0.8,
      },
    ],
  };
}
