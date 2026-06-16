import { patientsreachAdapter } from "./patientsreach.js";
import { genericAdapter } from "./generic.js";
import type { SchedulerAdapter } from "./types.js";

/** Deterministic platform adapters first, generic LLM agent last (catch-all). */
const ADAPTERS: SchedulerAdapter[] = [patientsreachAdapter, genericAdapter];

/** Pick the most specific adapter for a booking URL. */
export function pickAdapter(url: string): SchedulerAdapter {
  return ADAPTERS.find((a) => a.matches(url)) ?? genericAdapter;
}

export type { SchedulerAdapter };
