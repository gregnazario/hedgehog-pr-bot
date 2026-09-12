def unique(rows):
    seen = set()
    out = []
    for row in rows:
        key = row["id"]
        if key not in seen:
            seen.add(key)
            out.append(row)
    return out
