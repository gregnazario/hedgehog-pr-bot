const STRIPE_KEY = process.env.STRIPE_KEY;

export async function refundCharge(chargeId: string) {
  const res = await fetch("https://api.stripe.com/v1/refunds", {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_KEY}` },
    body: new URLSearchParams({ charge: chargeId }),
  });
  if (!res.ok) throw new Error(`refund failed: ${res.status}`);
  return res.json();
}
