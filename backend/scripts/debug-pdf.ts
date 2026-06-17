// Isolate whether OpenRouter actually parses our PDF. Sends the file part + pdf-text plugin and
// asks for plain text back. Run: npx tsx --env-file=.env scripts/debug-pdf.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { config } from "../src/config.js";

const pdf = readFileSync(`${homedir()}/Downloads/Lab Results of Record.pdf`);
const dataUrl = `data:application/pdf;base64,${pdf.toString("base64")}`;

const body = {
  model: config.webAgent.model || "anthropic/claude-opus-4.8",
  max_tokens: 600,
  messages: [
    {
      role: "user",
      content: [
        { type: "file", file: { filename: "labs.pdf", file_data: dataUrl } },
        { type: "text", text: "What is this document? List the first 5 lab tests and their values you can read from it." },
      ],
    },
  ],
  plugins: [{ id: "file-parser", pdf: { engine: "pdf-text" } }],
  stream: false,
};

const res = await fetch(`${config.webAgent.baseUrl}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.webAgent.apiKey}` },
  body: JSON.stringify(body),
});
console.log("HTTP", res.status);
const json: any = await res.json();
if (json.error) console.log("ERROR:", JSON.stringify(json.error).slice(0, 400));
console.log("MODEL:", json.model);
console.log("CONTENT:\n", json.choices?.[0]?.message?.content?.slice(0, 800) ?? "(none)");
console.log("usage:", JSON.stringify(json.usage));
process.exit(0);
