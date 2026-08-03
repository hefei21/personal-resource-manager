# Stage 0 isolated testing

This project includes a disposable test stack that never mounts the production
data directory.

## Requirements

- Windows PowerShell 7 or newer
- Docker Desktop with Docker Compose v2
- Free localhost ports `13000` and `15173`

## One-command baseline

From the repository root:

```powershell
.\tools\test.ps1 all
```

If the local PowerShell execution policy blocks project scripts, run:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\tools\test.ps1 all
```

The command:

1. stops an existing `pr-test` stack;
2. recreates `.codex/test-runtime/`;
3. generates random test credentials;
4. generates synthetic fixtures;
5. builds and starts the isolated containers;
6. runs smoke and characterization tests;
7. records reliability and latency baselines;
8. writes a report under `.codex/test-reports/`.

The stack remains running for browser inspection. Remove it and all generated
runtime data with:

```powershell
.\tools\test.ps1 down -Cleanup
```

## Individual commands

```powershell
.\tools\test.ps1 prepare
.\tools\test.ps1 up
.\tools\test.ps1 smoke
.\tools\test.ps1 scenarios
.\tools\test.ps1 report
.\tools\test.ps1 down
```

Run `prepare` only when it is safe to reset the disposable test data. It stops
the test stack and replaces the generated credentials, fixtures, database and
result files.

## Endpoints and isolation

| Component | Address |
|---|---|
| Frontend | `http://127.0.0.1:15173` |
| Backend health | `http://127.0.0.1:13000/api/health` |
| Redis | Docker network only |

All bind mounts are below `.codex/test-runtime/data/`. The test script validates
the runtime path before cleanup, and the Compose file binds the PC ports to
loopback only.

Redis is not published by default. To inspect it temporarily from the PC:

```powershell
.\tools\test.ps1 up -PublishRedisPort
```

This applies `docker-compose.test.redis-debug.yml` and binds Redis to
`127.0.0.1:16379`.

## Result statuses

- `PASS`: current baseline behavior is available.
- `FAIL`: blocking baseline failure.
- `KNOWN_FAIL`: confirmed defect retained for stage 1.
- `SKIP`: intentionally outside the automated stage-0 environment.
- `MANUAL`: requires browser or NAS GUI inspection.

`KNOWN_FAIL` tests must become enforced `PASS` tests when the corresponding
stage-1 security issue is fixed.

## Synthetic fixtures

The generator creates privacy-safe TXT, Markdown, JSON, CSV, DOCX, XLSX, EPUB,
PNG, WAV and sample code repository fixtures. Generated files are runtime
artifacts and are not committed.

## NAS baseline images

The `Build baseline container images` GitHub Actions workflow publishes:

```text
ghcr.io/hefei21/personal-resource-manager-backend:<tag>
ghcr.io/hefei21/personal-resource-manager-frontend:<tag>
```

Trigger it with an immutable tag such as `baseline-20260729`, or push a Git tag
whose name starts with `baseline-`.

Import `docker-compose.nas-test.yml` in the NAS GUI and provide:

- `IMAGE_TAG`
- `TEST_DATA_ROOT`
- `NAS_HOST`
- `TEST_ADMIN_USERNAME`
- `TEST_ADMIN_PASSWORD`

Use a new NAS directory and ports `13000` and `15173`. Never point the test
Compose file at the production data directory.

After the isolated baseline succeeds, `docker-compose.nas.yml` is the
image-based production replacement for the previous NAS source-build Compose.
Populate its variables from `.env.nas.example` in the NAS GUI. Do not upload
the populated environment file or commit it to Git.

GHCR packages may require a one-time visibility change or registry login before
the NAS can pull them. Prefer public, read-only images for this public project;
never store a GitHub write token in Compose.
