import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessageParts } from "../src/sources/gmail.js";
import { decodeBody, header } from "../src/services/google.js";
import type { GmailMessage } from "../src/services/google.js";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

// A realistic multipart Gmail message: text/plain body + one PDF attachment.
const SAMPLE: GmailMessage = {
  id: "msg-1",
  internalDate: "1718452800000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "Subject", value: "Your lab results are ready" },
      { name: "From", value: "MyChart <no-reply@mychart.example.org>" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Hemoglobin A1c 6.4% (high). Your appointment is June 24.") } },
          { mimeType: "text/html", body: { data: b64url("<p>ignored when plain exists</p>") } },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "results.pdf",
        body: { attachmentId: "att-123", size: 5000 },
      },
    ],
  },
};

test("parseMessageParts extracts subject, plain body, and attachments", () => {
  const parsed = parseMessageParts(SAMPLE);
  assert.equal(parsed.subject, "Your lab results are ready");
  assert.match(parsed.bodyText, /Hemoglobin A1c 6\.4%/);
  assert.ok(!parsed.bodyText.includes("ignored"), "prefers text/plain over html");
  assert.equal(parsed.attachments.length, 1);
  assert.deepEqual(parsed.attachments[0], {
    filename: "results.pdf",
    mimeType: "application/pdf",
    attachmentId: "att-123",
  });
});

test("parseMessageParts falls back to stripped HTML when no plain text", () => {
  const htmlOnly: GmailMessage = {
    id: "msg-2",
    payload: {
      mimeType: "text/html",
      headers: [{ name: "Subject", value: "HTML only" }],
      body: { data: b64url("<h1>Visit</h1><p>Glucose <b>142</b> mg/dL</p>") },
    },
  };
  const parsed = parseMessageParts(htmlOnly);
  assert.match(parsed.bodyText, /Visit/);
  assert.match(parsed.bodyText, /Glucose 142 mg\/dL/);
  assert.ok(!parsed.bodyText.includes("<"), "html tags stripped");
});

test("google helpers: decodeBody + header", () => {
  assert.equal(decodeBody(b64url("hello world")), "hello world");
  assert.equal(decodeBody(undefined), "");
  assert.equal(header(SAMPLE.payload, "subject"), "Your lab results are ready"); // case-insensitive
  assert.equal(header(SAMPLE.payload, "missing"), undefined);
});
