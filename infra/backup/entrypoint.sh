#!/bin/sh
set -eu

if [ -z "${BACKUP_AGE_RECIPIENT:-}" ]; then
  echo "BACKUP_AGE_RECIPIENT is required (age public recipient)." >&2
  exit 1
fi
mkdir -p /backups
export PGPASSWORD="$(cat "${PGPASSWORD_FILE:-/run/secrets/postgres_password}")"

while true; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="/backups/postgres-$stamp.dump.age"
  pg_dump --format=custom --no-owner --no-acl | age -r "$BACKUP_AGE_RECIPIENT" -o "$target"
  (
    cd /backups
    sha256sum "$(basename "$target")" > "$(basename "$target").sha256"
  )
  find /backups -type f -name 'postgres-*.dump.age*' -mtime "+${BACKUP_RETENTION_DAYS:-30}" -delete
  echo "Encrypted PostgreSQL backup created: $target"
  if [ "${BACKUP_INTERVAL_SECONDS:-86400}" = "0" ]; then
    exit 0
  fi
  sleep "${BACKUP_INTERVAL_SECONDS:-86400}"
done
