import Stripe from "stripe";
import { config, enabled } from "../config.js";

let client: Stripe | null = null;
function stripe(): Stripe {
  if (!client) client = new Stripe(config.stripe.secretKey);
  return client;
}

export interface PaymentIntentResult {
  paymentIntentId: string;
  clientSecret: string;
}

/**
 * Create a PaymentIntent for one session. In mock mode (no key) returns a fake
 * client secret so the iOS flow can be walked without Stripe.
 */
export async function createPaymentIntent(sessionId: string): Promise<PaymentIntentResult> {
  if (!enabled.stripe()) {
    return { paymentIntentId: `mock_pi_${sessionId}`, clientSecret: `mock_secret_${sessionId}` };
  }
  const pi = await stripe().paymentIntents.create({
    amount: config.sessionPriceCents,
    currency: "usd",
    metadata: { sessionId },
    automatic_payment_methods: { enabled: true },
  });
  return { paymentIntentId: pi.id, clientSecret: pi.client_secret! };
}

/** Verify and parse a Stripe webhook event from the raw body + signature header. */
export function constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  return stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}
