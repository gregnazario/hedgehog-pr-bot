export async function orderSummary(db: DB, ids: string[]) {
  const orders = await db.all("SELECT * FROM orders WHERE id = ANY($1)", [ids]);
  return orders.map(async (o) => ({
    ...o,
    items: await db.all("SELECT * FROM items WHERE order_id = $1", [o.id]),
  }));
}
