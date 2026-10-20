#!/bin/sh
# Dev only: runs once on an empty data dir. Creates the app LOGIN user as a member of gw_app.
# Migrations (run as the owner) create gw_app too and grant it table privileges; this pre-creates it so the
# login user can be granted membership before the first migration.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gw_app') THEN CREATE ROLE gw_app NOLOGIN; END IF;
END \$\$;
CREATE ROLE gateway_app LOGIN PASSWORD '${APP_DB_PASSWORD}' IN ROLE gw_app;
SQL
