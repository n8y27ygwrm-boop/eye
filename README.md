# EYE

This local repository contains the verified candidate source of record for EYE. The application baseline was recovered from the exact Phase 11 production deployment source; historical application files were not copied over it. GitHub `main` remains historical until this recovery branch is published and merged, so it must not be used as a production source yet.

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

After the recovery branch is published and merged, deploy production only from a clean, reviewed revision of the authoritative GitHub `main` branch. Before deployment, record the full Git commit SHA and confirm the working tree is clean. After deployment, record the Vercel deployment ID and the exact source revision used in the release log. Confirm the production alias points to that deployment. Do not use a separate local source folder as a release source.

The current deployed Phase 11 release predates this rule:

| Production alias | Deployment ID | Application source revision | Source method |
| --- | --- | --- | --- |
| `eye-savvyedge.vercel.app` | `dpl_8JhPYjokk9JALrG1Jr1rnSqZo5hD` | `d15bc8a` (application tree; `eba23b9` added a test only) | Vercel CLI source upload |

The Phase 12 repository recovery does not deploy or change production. See [recovery notes](docs/phase12-recovery.md) for provenance and test classification.
