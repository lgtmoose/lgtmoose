# The Postgres the integration tests run against, in CI and locally. Pinned by digest so a new
# Postgres or pgvector release is a deliberate change; Dependabot proposes updates. Keep the major
# version in line with the RDS engine in infra/cdk/lib/data-stack.ts.
# PostgreSQL 18.6 with pgvector 0.8.7.
FROM pgvector/pgvector:pg18@sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782
