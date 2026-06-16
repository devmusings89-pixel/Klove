// Verifies the email pipeline minus the IMAP socket: a raw RFC822 message is parsed exactly as
// imap.sync does (mailparser), turned into artifacts, ingested, and run through extraction.
// Usage: npm run test-email-ingest
import { simpleParser } from "mailparser";
import { prisma } from "../src/db.js";
import { ingestArtifact } from "../src/services/ingestion.js";
import { runExtractionTick } from "../src/services/health-worker.js";
import type { RawArtifact } from "../src/sources/types.js";

const RAW = `From: MyChart <no-reply@mychart.example.org>
To: patient@example.com
Subject: Your upcoming appointment and recent lab results
Date: Mon, 15 Jun 2026 09:00:00 -0400
Content-Type: text/plain; charset=utf-8

Hello,

This confirms your Endocrinology follow-up with Dr. Lin on June 24, 2026 at 2:00 PM,
City Endocrinology, 500 Main St, Suite 210.

Your recent labs are available: Hemoglobin A1c 6.4% (high), Glucose 142 mg/dL (high).

Thank you,
MyChart
`;

async function main() {
  const user = await prisma.user.upsert({
    where: { email: "test-email@klove.app" },
    create: { email: "test-email@klove.app" },
    update: {},
  });

  // Same parse → artifact logic as sources/imap.ts.
  const parsed = await simpleParser(Buffer.from(RAW));
  const artifacts: RawArtifact[] = [];
  if (parsed.text?.trim()) {
    artifacts.push({
      sourceRef: `test:body`,
      mimeType: "text/plain",
      text: `Subject: ${parsed.subject}\n\n${parsed.text}`,
      originalName: parsed.subject ?? "email",
      receivedAt: parsed.date?.toISOString(),
    });
  }
  console.log(`Parsed email "${parsed.subject}" → ${artifacts.length} artifact(s)`);

  for (const a of artifacts) {
    const r = await ingestArtifact(user.id, "imap", a);
    console.log(`  ingest: ${r.status} (${r.documentId})`);
  }

  // Drain the queue (extraction + chained analysis).
  for (let i = 0; i < 6; i++) await runExtractionTick();

  const [records, conditions, appts, alerts] = await Promise.all([
    prisma.observation.findMany({ where: { userId: user.id } }),
    prisma.condition.findMany({ where: { userId: user.id } }),
    prisma.appointment.findMany({ where: { userId: user.id } }),
    prisma.healthAlert.findMany({ where: { userId: user.id } }),
  ]);

  console.log("\nResults for", user.email);
  console.log("  observations:", records.map((o) => `${o.display}=${o.valueNum}${o.unit ?? ""}`));
  console.log("  conditions:  ", conditions.map((c) => c.display));
  console.log("  appointments:", appts.map((a) => `${a.title} @ ${a.startsAt?.toISOString() ?? "?"} (${a.provider ?? ""})`));
  console.log("  alerts:      ", alerts.map((a) => a.title));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
