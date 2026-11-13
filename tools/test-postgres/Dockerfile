# The Postgres the integration tests run against, in CI and locally. Pinned by digest so a new
# Postgres or pgvector release is a deliberate change; Dependabot proposes updates. Keep the major
# version in line with the RDS and Aurora engine in infra/cdk/lib/data-stack.ts.
# PostgreSQL 18.6 with pgvector 0.8.7.
FROM pgvector/pgvector:pg18@sha256:c29f30688a9ad961691bdf0ec1650717cc132a5814619d80f80463d6e4c42e47
