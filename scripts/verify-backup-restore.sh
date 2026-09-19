#!/bin/sh
set -eu

: "${BACKUP_FILE:?BACKUP_FILE is required}"

case "$BACKUP_FILE" in
  postgres-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.dump.age) ;;
  *)
    echo "Refusing unexpected backup filename: $BACKUP_FILE" >&2
    exit 1
    ;;
esac

restore_db="${RESTORE_DB:-mining_gateway_restore_check}"
case "$restore_db" in
  mining_gateway_restore_check | mining_gateway_restore_check_[a-z0-9_]*) ;;
  *)
    echo "Refusing unexpected restore database name: $restore_db" >&2
    exit 1
    ;;
esac

backup_path="${BACKUP_DIR:-/backups}/$BACKUP_FILE"
identity_path="${AGE_IDENTITY_FILE:-/keys/backup-age-identity.txt}"
password_path="${PGPASSWORD_FILE:-/keys/postgres-password.txt}"
pg_host="${PGHOST:-postgres}"
pg_port="${PGPORT:-5432}"
pg_user="${PGUSER:-mining}"
source_db="${PGDATABASE:-mining_gateway}"
expected_migrations="${EXPECTED_MIGRATIONS:-6}"

for required_file in "$backup_path" "$identity_path" "$password_path"; do
  if [ ! -f "$required_file" ]; then
    echo "Required file not found: $required_file" >&2
    exit 1
  fi
done

export PGPASSWORD="$(cat "$password_path")"

database_exists() {
  psql \
    --host "$pg_host" \
    --port "$pg_port" \
    --username "$pg_user" \
    --dbname "$source_db" \
    --tuples-only \
    --no-align \
    --command "SELECT 1 FROM pg_database WHERE datname = '$restore_db';"
}

if [ "$(database_exists)" = "1" ]; then
  echo "Refusing to overwrite existing database: $restore_db" >&2
  exit 1
fi

cleanup() {
  if [ "$(database_exists)" = "1" ]; then
    dropdb \
      --host "$pg_host" \
      --port "$pg_port" \
      --username "$pg_user" \
      "$restore_db"
    echo "Removed temporary restore database: $restore_db"
  fi
}
trap cleanup EXIT HUP INT TERM

createdb \
  --host "$pg_host" \
  --port "$pg_port" \
  --username "$pg_user" \
  --template template0 \
  "$restore_db"

age --decrypt --identity "$identity_path" "$backup_path" |
  pg_restore \
    --host "$pg_host" \
    --port "$pg_port" \
    --username "$pg_user" \
    --dbname "$restore_db" \
    --no-owner \
    --no-acl \
    --exit-on-error

migration_count="$(
  psql \
    --host "$pg_host" \
    --port "$pg_port" \
    --username "$pg_user" \
    --dbname "$restore_db" \
    --tuples-only \
    --no-align \
    --command 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;'
)"

if [ "$migration_count" != "$expected_migrations" ]; then
  echo "Expected $expected_migrations applied migrations, found $migration_count" >&2
  exit 1
fi

table_count="$(
  psql \
    --host "$pg_host" \
    --port "$pg_port" \
    --username "$pg_user" \
    --dbname "$restore_db" \
    --tuples-only \
    --no-align \
    --command "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
)"

echo "Encrypted restore verified: backup=$BACKUP_FILE migrations=$migration_count public_tables=$table_count"
