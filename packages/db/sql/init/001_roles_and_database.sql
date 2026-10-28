-- Runs once, on first start of the local postgres container (docker-entrypoint-initdb.d), as the bootstrap superuser.
-- Local placeholders only. In AWS the same roles are created by Terraform/RDS with Secrets Manager passwords.
-- No role here bypasses row-level security; FORCE RLS in the migrations therefore binds every connection, owner included.

CREATE ROLE codex_migrator LOGIN PASSWORD 'migrator-local-only'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE codex_app LOGIN PASSWORD 'app-local-only'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE codex_worker LOGIN PASSWORD 'worker-local-only'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;

-- Lets a migrator connection SET ROLE to the app and worker roles, which is how the RLS tests exercise them.
GRANT codex_app, codex_worker TO codex_migrator;

CREATE DATABASE codex_health OWNER codex_migrator;
REVOKE CONNECT ON DATABASE codex_health FROM PUBLIC;
GRANT CONNECT ON DATABASE codex_health TO codex_app, codex_worker;
