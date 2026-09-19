#!/bin/sh
set -eu
umask 077

if [ -z "${BACKUP_AGE_RECIPIENT:-}" ]; then
  echo "BACKUP_AGE_RECIPIENT is required (age public recipient)." >&2
  exit 1
fi
mkdir -p /backups
export PGPASSWORD="$(cat "${PGPASSWORD_FILE:-/run/secrets/postgres_password}")"

dump_tmp=''
encrypted_tmp=''
cleanup() {
  if [ -n "$dump_tmp" ]; then rm -f "$dump_tmp"; fi
  if [ -n "$encrypted_tmp" ]; then rm -f "$encrypted_tmp"; fi
}
trap cleanup EXIT HUP INT TERM

while true; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="/backups/postgres-$stamp.dump.age"
  dump_tmp="$(mktemp /tmp/postgres-backup.XXXXXX.dump)"
  encrypted_tmp="$target.tmp"
  rm -f "$encrypted_tmp"

  # Keep pg_dump and encryption as separate checked steps. POSIX sh has no
  # portable pipefail, so a direct pipeline could hide a failed pg_dump.
  pg_dump --format=custom --no-owner --no-acl --file "$dump_tmp"
  if [ ! -s "$dump_tmp" ]; then
    echo 'pg_dump produced an empty file' >&2
    exit 1
  fi
  age -r "$BACKUP_AGE_RECIPIENT" -o "$encrypted_tmp" "$dump_tmp"
  mv "$encrypted_tmp" "$target"
  rm -f "$dump_tmp"
  dump_tmp=''
  encrypted_tmp=''
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
