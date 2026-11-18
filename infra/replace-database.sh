#!/usr/bin/env bash
# Replaces the production database with another SQLite file (a restore, or
# bringing data from the old desktop app). Run it from your machine, in
# infra/, with gcloud logged in:
#
#   ./replace-database.sh caminho/para/banco.db
#
# What it does, on the VM:
#   1. stops the server, the update timer and the continuous backup;
#   2. keeps a copy of the current database next to it
#      (/var/lib/tapago/tapago.db.antes-<data>);
#   3. remembers who is registered on "Usuários e perfis";
#   4. puts the new file in place and clears the old backup replica, so the
#      backup starts over from the new database;
#   5. starts the server (which applies any missing migration), puts the
#      registered people back, restarts the backup and prints the numbers.
#
# Initial admins (TAPAGO_ALLOWED_EMAILS) don't depend on the database and
# always keep their access.
set -euo pipefail

NEW_DB=${1:?"uso: $0 caminho/para/banco.db"}
PROJECT=${PROJECT:-$(tofu output -raw ssh_command 2>/dev/null | sed -E 's/.*--project ([^ ]+).*/\1/')}
ZONE=${ZONE:-us-east1-b}
VM=${VM:-tapago}
[ -n "$PROJECT" ] || { echo "Defina PROJECT=<id do projeto> (ou rode dentro de infra/, depois do tofu apply)." >&2; exit 1; }
[ -f "$NEW_DB" ] || { echo "Arquivo não encontrado: $NEW_DB" >&2; exit 1; }

echo "Conferindo $NEW_DB..."
check=$(sqlite3 "$NEW_DB" "PRAGMA integrity_check;")
[ "$check" = "ok" ] || { echo "O arquivo não passou na verificação do SQLite: $check" >&2; exit 1; }
sqlite3 "$NEW_DB" "SELECT 1 FROM _sqlx_migrations LIMIT 1;" >/dev/null 2>&1 || { echo "Esse arquivo não é um banco do Tá Pago (sem _sqlx_migrations)." >&2; exit 1; }

# A single-file snapshot (no -wal/-shm to carry along).
SNAPSHOT=$(mktemp -t tapago-novo-XXXXXX.db)
trap 'rm -f "$SNAPSHOT"' EXIT
sqlite3 "$NEW_DB" ".backup '$SNAPSHOT'"

SSH=(gcloud compute ssh "$VM" --zone "$ZONE" --project "$PROJECT" --tunnel-through-iap)
echo "Enviando para a VM $VM ($PROJECT)..."
gcloud compute scp "$SNAPSHOT" "$VM:/tmp/tapago-novo.db" --zone "$ZONE" --project "$PROJECT" --tunnel-through-iap

"${SSH[@]}" --command 'sudo bash -s' <<'REMOTE'
set -euo pipefail
DB=/var/lib/tapago/tapago.db
NEW=/tmp/tapago-novo.db
REPLICA=$(awk '/url: gcs:/ {print $3}' /etc/litestream.yml | sed 's#^gcs://#gs://#')
STAMP=$(date -u +%Y%m%d-%H%M%S)

echo "Parando o servidor e o backup..."
systemctl stop tapago-update.timer tapago.service litestream.service

if [ -f "$DB" ]; then
  sqlite3 "$DB" ".backup '$DB.antes-$STAMP'"
  chown tapago:tapago "$DB.antes-$STAMP"
  echo "Banco anterior guardado em $DB.antes-$STAMP"
  # Who is registered on "Usuários e perfis", with the profile's name.
  sqlite3 -separator $'\t' "$DB" "SELECT u.email, p.name, u.added_by FROM app_users u JOIN access_profiles p ON p.id = u.profile_id;" > /tmp/tapago-usuarios.tsv 2>/dev/null || : > /tmp/tapago-usuarios.tsv
else
  : > /tmp/tapago-usuarios.tsv
fi

rm -f "$DB" "$DB-wal" "$DB-shm"
install -o tapago -g tapago -m 640 "$NEW" "$DB"
rm -f "$NEW"

echo "Zerando a réplica antiga do backup ($REPLICA)..."
gcloud storage rm -r "$REPLICA" --quiet 2>/dev/null || echo "(não havia réplica)"

echo "Subindo o servidor..."
systemctl start tapago.service
for i in $(seq 1 30); do
  curl -fsS --max-time 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 2 http://127.0.0.1:8787/api/health >/dev/null || { echo "O servidor não respondeu. Veja: journalctl -u tapago -n 50" >&2; exit 1; }

# Put the registered people back (the new file may not even have the table
# before the server's migrations ran; it does now).
while IFS=$'\t' read -r email profile added_by; do
  [ -n "$email" ] || continue
  runuser -u tapago -- sqlite3 "$DB" "INSERT INTO app_users (email, profile_id, added_by)
    SELECT '$email', COALESCE((SELECT id FROM access_profiles WHERE name = '$profile'), (SELECT id FROM access_profiles WHERE name = 'Visualizador')), '$added_by'
    WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE email = '$email');"
  echo "Acesso mantido: $email ($profile)"
done < /tmp/tapago-usuarios.tsv
rm -f /tmp/tapago-usuarios.tsv

systemctl start litestream.service tapago-update.timer

echo
echo "Banco novo no ar:"
sqlite3 "$DB" "SELECT 'migration mais recente: ' || MAX(installed_on) FROM _sqlx_migrations;
  SELECT 'empresas: ' || COUNT(*) FROM companies;
  SELECT 'clientes: ' || COUNT(*) FROM clients;
  SELECT 'colaboradores: ' || COUNT(*) FROM employees;
  SELECT 'espelhos: ' || COUNT(*) FROM imports;
  SELECT 'turnos de pagamento: ' || COUNT(*) FROM payment_shifts;
  SELECT 'usuários cadastrados: ' || COUNT(*) FROM app_users;"
systemctl is-active tapago.service litestream.service
REMOTE
