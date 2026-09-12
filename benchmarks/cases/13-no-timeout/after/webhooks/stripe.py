import httpx

async def deliver(url: str, payload: dict):
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
