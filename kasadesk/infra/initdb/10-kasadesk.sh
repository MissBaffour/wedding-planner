#!/bin/sh
# Runs once, on first container start, as the postgres superuser.
set -e
psql -v ON_ERROR_STOP=1 -U postgres -d postgres -f /kasadesk-db/roles.sql
psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "CREATE DATABASE kasadesk OWNER kasadesk_migrator"
for f in /kasadesk-db/migrations/*.sql; do
  echo "applying $f"
  psql -v ON_ERROR_STOP=1 -U postgres -d kasadesk -c "SET ROLE kasadesk_migrator" -f "$f"
done
