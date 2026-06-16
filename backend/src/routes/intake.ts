import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireUser } from "../services/auth.js";
import { parseBookingIntent, type BookingDraft } from "../services/intake.js";

const IntakeParseSchema = z.object({
  text: z.string().min(1),
  // The conversation's accumulated draft, echoed back each turn so slots persist.
  draft: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Natural-language booking front-door. Turns "book me a dentist visit" into a structured
 * BookingDraft (reusing past providers), one clarifying question at a time. The confirmed draft is
 * mapped client-side to the existing POST /sessions — the booking engine is untouched.
 */
export async function intakeRoutes(app: FastifyInstance) {
  app.post("/intake/parse", { preHandler: requireUser }, async (req, reply) => {
    const parsed = IntakeParseSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const appointments = await prisma.appointment.findMany({
      where: { userId: req.user!.id },
      orderBy: { startsAt: "desc" },
      take: 50,
    });

    const draft: BookingDraft = await parseBookingIntent(
      parsed.data.text,
      appointments,
      parsed.data.draft as Partial<BookingDraft> | undefined,
    );
    return draft;
  });
}
