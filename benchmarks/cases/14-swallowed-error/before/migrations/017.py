def up(conn):
    with conn.transaction():
        conn.execute("ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'")
        conn.execute("UPDATE users SET tier = 'pro' WHERE plan = 'professional'")
