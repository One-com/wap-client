# WAP Kubernetes deployment

Manifests + tooling to deploy the WAP FastAPI backend (`py-backend/`) to Kubernetes across three
environments. Modeled on the group.one `monies-deploy` pattern: per-environment YAML templated with
`envsubst` and applied by the GitLab CI `deploy` stage.

## Layout

```
kubernetes/
├── generate-yaml.sh     # envsubst over all *.yaml in the env dir, concatenated with ---
├── print-env.sh         # prints the template variable values (CI log aid)
├── test/                # one namespace per environment
├── staging/
└── production/
```

Each environment directory contains:

| File | Purpose |
|------|---------|
| `configmap.yaml` | Non-secret config: `ENV`, `REDIS_URL`, `ALLOWED_ORIGINS`, `PROMETHEUS_ENABLED` |
| `deployment.yaml` | App Deployment + `alembic upgrade head` initContainer |
| `service.yaml` | ClusterIP, port 80 → 8000 |
| `ingress-public.yaml` | Public ingress (`public-default-ingress`), host `${K8S_NAMESPACE}.public-default…`: `/api`, `/health` |
| `ingress-internal.yaml` | Internal ingress (`nginx`), host `${K8S_NAMESPACE}.default…`: `/admin` |
| `networkpolicy.yaml` | Egress: public IPs allowed, RFC1918 blocked; DNS + in-cluster Redis allowed |

## Environments

| | test | staging | production |
|---|---|---|---|
| Namespace | `wordpress-agentic-platform-test` | `wordpress-agentic-platform-staging` | `wordpress-agentic-platform-production` |
| Cluster / context | k8spod4-cph3 / `k8spod4` | same | same |
| Deploy trigger | manual (any non-develop/non-trunk branch) | auto on `develop` | auto on `trunk` |
| Public API host | `wordpress-agentic-platform-test.public-default.k8spod4-cph3.ingress.k8s.g1i.one` | `…-staging.public-default…` | `…-production.public-default…` |
| Admin host (internal) | `wordpress-agentic-platform-test.default.k8spod4-cph3.ingress.k8s.g1i.one` | `…-staging.default…` | `…-production.default…` |
| Replicas | 1 | 1 | 2 |

## Template variables

`generate-yaml.sh` substitutes these (set by the CI deploy job):

- `RELEASE_ENVIRONMENT` — `test` / `staging` / `production`
- `K8S_NAMESPACE` — target namespace
- `APP_IMAGE_NAME` — `harbor.one.com/cpo-eng/wap-poc`
- `RELEASE_COMMIT_SHORT_SHA` — `$CI_COMMIT_SHORT_SHA` (image tag)
- `CONFIGMAP_HASH` — md5 of `configmap.yaml`, forces pod restart on config change

## Secrets (managed outside this repo)

Both are Bitnami **SealedSecrets**, namespace-wide, referenced by `deployment.yaml` via `secretKeyRef`.
Manifests contain **no secret values**.

- **`postgres`** — already provisioned per namespace. Keys: `PGHOST`, `PGUSER`, `PGPASSWORD`,
  `PGDATABASE`, `PGSSLMODE`. The container composes
  `DATABASE_URL=postgresql://$PGUSER:$PGPASSWORD@$PGHOST/$PGDATABASE?sslmode=$PGSSLMODE` from these.
- **`wap-app-secrets`** — **must be created** in each of the three namespaces. Keys:
  - `SESSION_ENCRYPTION_KEY` (required, base64-encoded 32-byte key)
  - `ADMIN_API_KEY` (required)
  - `ANTHROPIC_API_KEY` (required)
  - `LANGFUSE_PUBLIC_KEY` (optional)
  - `LANGFUSE_SECRET_KEY` (optional)
  - `SENTRY_DSN` (optional)

Redis is non-secret and configured via `REDIS_URL` in the ConfigMap
(`redis://redis.managed-redis.svc.cluster.local:6379/0`).

## Render locally

```bash
RELEASE_ENVIRONMENT=staging \
K8S_NAMESPACE=wordpress-agentic-platform-staging \
APP_IMAGE_NAME=harbor.one.com/cpo-eng/wap-poc \
RELEASE_COMMIT_SHORT_SHA=deadbeef \
CONFIGMAP_HASH=local \
./kubernetes/generate-yaml.sh | kubectl apply --dry-run=client -f -
```

Deployment is driven by the `deploy` stage in `.gitlab-ci.yml`.
