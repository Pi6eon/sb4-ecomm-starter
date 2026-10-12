#!/bin/sh
set -eu

case "$POSTGRES_REPLICATION_USER" in
  ""|*[!a-zA-Z0-9_]*) echo "POSTGRES_REPLICATION_USER may contain only letters, digits, and underscores" >&2; exit 1 ;;
esac
case "$POSTGRES_REPLICATION_PASSWORD" in
  ""|*[!0-9a-fA-F]*) echo "POSTGRES_REPLICATION_PASSWORD must be hexadecimal for safe .pgpass handling" >&2; exit 1 ;;
esac
if [ "${#POSTGRES_REPLICATION_PASSWORD}" -lt 32 ]; then
  echo "POSTGRES_REPLICATION_PASSWORD must contain at least 32 hexadecimal characters" >&2
  exit 1
fi

rule="host replication ${POSTGRES_REPLICATION_USER} 0.0.0.0/0 scram-sha-256"
grep -Fqx "$rule" "$PGDATA/pg_hba.conf" || printf '%s\n' "$rule" >> "$PGDATA/pg_hba.conf"

role_exists=$(psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM pg_roles WHERE rolname = '$POSTGRES_REPLICATION_USER'")
if [ "$role_exists" = "0" ]; then
  psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "CREATE ROLE \"$POSTGRES_REPLICATION_USER\" WITH LOGIN REPLICATION PASSWORD '$POSTGRES_REPLICATION_PASSWORD'"
else
  psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "ALTER ROLE \"$POSTGRES_REPLICATION_USER\" WITH LOGIN REPLICATION PASSWORD '$POSTGRES_REPLICATION_PASSWORD'"
fi

slot_exists=$(psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT count(*) FROM pg_replication_slots WHERE slot_name = 'shop_dr'")
if [ "$slot_exists" = "0" ]; then
  psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT pg_create_physical_replication_slot('shop_dr')"
fi

gosu postgres pg_ctl reload -D "$PGDATA"
