import type { DataSource, SourceType } from "./types.js";
import { uploadSource } from "./upload.js";
import { healthKitSource } from "./healthkit.js";
import { gmailSource } from "./gmail.js";
import { imapSource } from "./imap.js";
import { aggregatorSource } from "./aggregator.js";

/** All registered health-data sources, mirroring channels/registry.ts. */
const SOURCES: DataSource[] = [uploadSource, healthKitSource, gmailSource, imapSource, aggregatorSource];

export function getSource(type: SourceType): DataSource | undefined {
  return SOURCES.find((s) => s.type === type);
}

/** Sources that are poll-based (have a meaningful sync()) — driven by runIngestionTick. */
export function pollableSources(): DataSource[] {
  return [gmailSource, imapSource, aggregatorSource];
}
// gmailSource and imapSource now have real sync() implementations; aggregator remains a scaffold.
