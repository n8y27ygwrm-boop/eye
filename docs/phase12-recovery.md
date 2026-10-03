# Phase 12 recovery record

## Provenance

| Source | Git state | Relationship to production |
| --- | --- | --- |
| This checkout (`phase11-production`) | Local `codex/phase11` history; baseline `5ae161d`, Phase 11 runtime tip `d15bc8a`, test-only tip `eba23b9`; initially no remote | Exact Phase 11 deployment application source, verified by deployment file hashes during Phase 11 |
| `github.com/n8y27ygwrm-boop/eye`, `main` | Historical Git history ending at `ceb0c7f` on 2026-09-22; no tags or other remote branches | Older EYE development; useful provenance, not a source for current runtime files |
| `Documents/ChatGPT/eye` parent checkout | Unborn local `main`, no remote, older untracked files | Not authoritative |
| `Documents/Codex/2026-09-26/i-m-signed-in-to-vercel/work/phase4c-first-mutation/time-editor-review` | Local snapshot without `.git`; 25 test/fixture files | Latest complete historical test tree; application files are older and were not copied |
| Later Phase 4C/5 release snapshots | Local snapshots without `.git`; tests excluded | Historical release artifacts, not authoritative |

The historical GitHub `package-lock.json` is byte-identical to the production lockfile. Its `package.json` has the same dependencies but an older test script and lacks later migration scripts. The Phase 4C snapshot package and lockfiles match the production versions byte for byte; they were not copied.

## Recovered tests

Classification: **A** valid unchanged, **B** adapted to current intentional behavior or repository path, **C** obsolete, **D** uncertain. The 15 historical test entrypoints are:

| Test | Class | Reason |
| --- | --- | --- |
| `action-runtime.test.ts` | A | Current action authority and command boundaries |
| `action-scheduling.test.mjs` | A | Timezone scheduling |
| `action-surfaces.test.ts` | B | Phase 11 returns an authoritative save before its background refresh finishes; reset test now checks that a late refresh cannot repopulate old-account state |
| `ai-actions.test.ts` | A | AI proposal and confirmation safety |
| `ai-operational.test.ts` | B | Replaced old sibling-checkout paths with repository-relative paths; assertions retained |
| `client-actions-db.test.mjs` | A | Isolated PostgreSQL schema, command, idempotency and RLS boundary |
| `import.test.ts` | B | Phase 8 rejects unknown client statuses; adapted status assertions and removed old Downloads checkout paths |
| `legacy-actions.test.mjs` | A | Migration planning and local dry run; recovered its development script |
| `lifecycle.test.ts` | A | Client and visit lifecycle integrity |
| `location.test.ts` | A | Location privacy and visit attachment |
| `mobile-experience.test.ts` | A | Responsive architecture assertions |
| `phase2b-backfill.test.mjs` | A | Reconciliation and source preservation |
| `phase4a-readiness.test.mjs` | A | Writer freeze and authority gates |
| `phase4b-handover.test.ts` | A | RPC and handover fences |
| `user-isolation.test.ts` | A | Owner isolation |

No recovered test was discarded. The historical tree also supplied `register.mjs`, `loader.mjs`, six fixture files, and two SQL fixtures. The seven historical migration SQL files and two development scripts were restored only as test/development inputs; no migration was applied to production. The existing Phase 11 operational test is included in `npm test`.

The first concurrent full run passed 286/287 tests; the local PostgreSQL completion-event count in `client-actions-db.test.mjs` returned zero once, although that test passed alone before and after. An unchanged second full run passed 287/287. This intermittent assertion is recorded rather than hidden; CI will expose any recurrence.

## Publication status

The local `codex/phase12` branch includes the historical GitHub `main` lineage through a merge that preserves the production-aligned tree exactly. Automatic approval review rejected pushing the production-aligned source to the existing GitHub repository because the exact destination and payload were not expressly authorized. No remote branch, pull request, or GitHub CI run was created. Publishing and merging this branch remain required before GitHub `main` can be called authoritative.
