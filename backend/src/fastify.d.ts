import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** Raw request bytes, captured for webhook signature verification. */
    rawBody?: Buffer;
    /** Authenticated user, attached by the requireUser preHandler on health routes. */
    user?: { id: string; email: string };
  }
}
