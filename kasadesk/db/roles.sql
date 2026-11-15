-- KasaDesk database roles. Run ONCE per cluster as a superuser, before migrations.
-- Passwords are placeholders: set real ones from your secret manager, e.g.
--   psql -v app_pw=... -v sys_pw=... -v mig_pw=... -f db/roles.sql
--
-- kasadesk_migrator : owns all objects, runs migrations. Never used by the running app.
-- kasadesk_app      : used by API + worker for all tenant work. RLS is ENFORCED (NOBYPASSRLS).
-- kasadesk_system   : BYPASSRLS. Used only by the worker's cross-tenant sweeps
--                     (trial expiry, retention purge, SLA scans, outbox relay).
--                     Code that may import this pool is restricted by a lint rule.

\if :{?app_pw}
\else
  \set app_pw dev_app_pw
\endif
\if :{?sys_pw}
\else
  \set sys_pw dev_sys_pw
\endif
\if :{?mig_pw}
\else
  \set mig_pw dev_mig_pw
\endif

SELECT format('CREATE ROLE kasadesk_migrator LOGIN NOBYPASSRLS PASSWORD %L', :'mig_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasadesk_migrator') \gexec
SELECT format('CREATE ROLE kasadesk_app LOGIN NOBYPASSRLS PASSWORD %L', :'app_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasadesk_app') \gexec
SELECT format('CREATE ROLE kasadesk_system LOGIN BYPASSRLS PASSWORD %L', :'sys_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasadesk_system') \gexec
