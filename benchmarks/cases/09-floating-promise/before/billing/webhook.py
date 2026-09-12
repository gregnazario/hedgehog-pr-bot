async def handle(event):
    charge = await fetch_charge(event["id"])
    await record(charge)
    return ok(charge)
