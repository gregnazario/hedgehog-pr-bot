async def handle(event):
    charge = await fetch_charge(event["id"])
    record(charge)
    return ok(charge)
