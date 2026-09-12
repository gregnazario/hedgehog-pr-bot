def unique(rows):
    out = []
    for row in rows:
        if row not in out:
            out.append(row)
    return out
