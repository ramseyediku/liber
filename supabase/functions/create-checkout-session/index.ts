// Starts a Stripe Checkout for the one-time unlock. client_reference_id is
// the caller's own auth.uid() (anonymous or permanent — Stripe Checkout
// doesn't care which), so the webhook can mark the right account paid with
// no sign-up required. Also generates a restore code here, before payment
// completes: its hash travels in the Checkout Session's metadata so the
// webhook can record it, and the plain code is returned now so the
// extension can store/display it immediately ("save this code") rather
// than needing a second round-trip after payment.
//
// Required secrets (supabase secrets set ...): STRIPE_API_KEY,
// STRIPE_PRICE_ID, STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL.
import Stripe from "npm:stripe@^22";
import { getCallerUser } from "../_shared/client.ts";
import { handleCors, json } from "../_shared/cors.ts";
import { generateRestoreCode, sha256Hex } from "../_shared/hash.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_API_KEY") as string);

Deno.serve(async (req: Request) => {
  const preflight = handleCors(req);
  if (preflight) return preflight;

  const caller = await getCallerUser(req);
  if (!caller) return json({ error: "unauthorized" }, 401);

  const restoreCode = generateRestoreCode();
  const restoreCodeHash = await sha256Hex(restoreCode);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: Deno.env.get("STRIPE_PRICE_ID"), quantity: 1 }],
    success_url: Deno.env.get("STRIPE_SUCCESS_URL")!,
    cancel_url: Deno.env.get("STRIPE_CANCEL_URL")!,
    client_reference_id: caller.id,
    metadata: { restore_code_hash: restoreCodeHash },
  });

  if (!session.url) return json({ error: "checkout session has no url" }, 500);

  return json({ checkoutUrl: session.url, restoreCode });
});
