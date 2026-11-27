// Handles Stripe's checkout.session.completed (unlock) and
// charge.refunded/charge.dispute.created (revoke) events. Verified against
// the Stripe-Signature header — Stripe never sends a Supabase JWT, so this
// function must be deployed with JWT verification OFF:
//   supabase functions deploy stripe-webhook --no-verify-jwt
//
// Pattern (import, client construction, async signature verification with
// an explicit Web Crypto provider) confirmed directly against Supabase's
// own official Stripe-webhook example — Deno's crypto support needs the
// async verifier, not the normal sync constructEvent.
//
// Required secrets: STRIPE_API_KEY, STRIPE_WEBHOOK_SIGNING_SECRET.
import Stripe from "npm:stripe@^22";
import { getServiceClient } from "../_shared/client.ts";
import { corsHeaders } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_API_KEY") as string);
const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req: Request) => {
  const signature = req.headers.get("Stripe-Signature");
  const body = await req.text(); // raw text — signature verification needs the exact bytes Stripe sent

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature!,
      Deno.env.get("STRIPE_WEBHOOK_SIGNING_SECRET")!,
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    console.error("stripe-webhook: signature verification failed", err);
    return new Response(`signature verification failed: ${err}`, { status: 400 });
  }

  const supabase = getServiceClient();

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const restoreCodeHash = session.metadata?.restore_code_hash ?? null;
    if (restoreCodeHash) {
      const { error } = await supabase.rpc("record_purchase", {
        p_session_id: session.id,
        p_payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : null,
        p_user: session.client_reference_id,
        p_restore_hash: restoreCodeHash,
      });
      if (error) console.error("stripe-webhook: record_purchase failed", error);
    }
  } else if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
    if (paymentIntentId) {
      const { error } = await supabase.rpc("revoke_purchase", {
        p_payment_intent: paymentIntentId,
        p_status: "refunded",
      });
      if (error) console.error("stripe-webhook: revoke_purchase (refund) failed", error);
    }
  } else if (event.type === "charge.dispute.created") {
    const dispute = event.data.object as Stripe.Dispute;
    const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : null;
    if (paymentIntentId) {
      const { error } = await supabase.rpc("revoke_purchase", {
        p_payment_intent: paymentIntentId,
        p_status: "disputed",
      });
      if (error) console.error("stripe-webhook: revoke_purchase (dispute) failed", error);
    }
  }

  // Always 2xx quickly once verified — Stripe retries on anything else.
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
