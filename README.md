# EYE

GitHub [`main`](https://github.com/n8y27ygwrm-boop/eye) is the authoritative source of record for EYE. Its application baseline was recovered from the exact Phase 11 production deployment source; historical application files were not copied over it.

## Development and verification

Use Node 24.21.0 (`.node-version`) and npm 11.9.0. The Vercel project is configured for Node 24.x. The complete test suite starts disposable, socket-only local PostgreSQL instances for database boundary tests; PostgreSQL server tools (`initdb`, `pg_ctl`, `psql`) must be on `PATH`.

```sh
npm ci
npm run typecheck
npm test
npm run build
git diff --check
```

Do not point tests at production. The test suite uses fixtures and temporary local databases. CI runs the same checks on pull requests and pushes to `main`.

## Release rule

Deploy production only from a clean, reviewed revision of the authoritative GitHub `main` branch. Before deployment, record the full Git commit SHA and confirm the working tree is clean. After deployment, record the Vercel deployment ID and the exact source revision used in the release log. Confirm the production alias points to that deployment. Do not use a separate local source folder as a release source.

Current production release:

| Production alias | Deployment ID | Git ref and revision | Source method |
| --- | --- | --- | --- |
| `eye-savvyedge.vercel.app` | `dpl_7havXcyT2LCakKnTkwVfVASkXsvE` | `main` at `198ed7f143a13201cf660ebc085b709c448f2376` | Vercel Git deployment |

See [recovery notes](docs/phase12-recovery.md) for provenance and test classification.
