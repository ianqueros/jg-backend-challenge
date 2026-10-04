-- The container administrator creates the application role and its databases.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jungle_main') THEN
    CREATE ROLE jungle_main WITH LOGIN PASSWORD 'main_local' NOSUPERUSER;
  END IF;
END;
$$;

SELECT 'CREATE DATABASE jungle OWNER jungle_main'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'jungle')\gexec

SELECT 'CREATE DATABASE jungle_test OWNER jungle_main'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'jungle_test')\gexec
