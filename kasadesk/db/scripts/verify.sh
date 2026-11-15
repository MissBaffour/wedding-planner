#!/usr/bin/env bash
# Creates a throwaway database, applies roles + migrations, runs the schema tests, drops it.
# Usage:  PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres ./db/scripts/verify.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DB="kasadesk_verify_$$"
PSQL=(psql -X -v ON_ERROR_STOP=1 -q)

cleanup() { "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${PSQL[@]}" -d postgres -f roles.sql
"${PSQL[@]}" -d postgres -c "CREATE DATABASE $DB OWNER kasadesk_migrator"

for f in migrations/*.sql; do
  echo "apply $f"
  # Run migrations as the owner role, exactly as production would.
  "${PSQL[@]}" -d "$DB" -c "SET ROLE kasadesk_migrator" -f "$f"
done

for t in tests/*.sql; do
  echo "test  $t"
  "${PSQL[@]}" -d "$DB" -f "$t"
done
