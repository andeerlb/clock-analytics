-- Who can sign in and what each person can do (Usuários e perfis).
--
-- A profile ("perfil") gives each area of the app a level (none / view /
-- edit) plus three extras (export, AI assistant, manage users), stored as
-- JSON in `permissions_json`:
--   {"areas": {"cadastros": "edit", ...}, "export": true, "ai": true, "users": false}
-- `is_admin = 1` marks the fixed "Admin" profile: everything allowed, not
-- editable or deletable, so nobody gets locked out.
--
-- The server's PONTOSCAN_ALLOWED_EMAILS are "initial admins": always Admin,
-- never stored here. Everyone else signs in only when listed in app_users.
CREATE TABLE access_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    permissions_json TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE app_users (
    email TEXT PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES access_profiles(id),
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT
);
CREATE INDEX idx_app_users_profile ON app_users(profile_id);

INSERT INTO access_profiles (name, permissions_json, is_admin) VALUES
  ('Admin',
   '{"areas":{"cadastros":"edit","espelhos":"edit","pagamentos":"edit","analises":"view","verificacao":"edit","configuracoes":"edit"},"export":true,"ai":true,"users":true}',
   1),
  ('Visualizador',
   '{"areas":{"cadastros":"view","espelhos":"view","pagamentos":"view","analises":"view","verificacao":"view","configuracoes":"none"},"export":false,"ai":false,"users":false}',
   0),
  ('Financeiro',
   '{"areas":{"cadastros":"view","espelhos":"view","pagamentos":"edit","analises":"view","verificacao":"edit","configuracoes":"none"},"export":true,"ai":true,"users":false}',
   0);
