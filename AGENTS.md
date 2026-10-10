# Repository Guidelines

## Project Structure & Module Organization

This repository currently contains an initial Node.js/TypeScript setup. `package.json` defines dependencies and package metadata; `package-lock.json` records dependency versions; `tsconfig.json` enables strict TypeScript checking. `node_modules/` contains installed dependencies and must not be edited or committed.

No application source, tests, or assets exist yet. For new work, organize application modules under `src/`, tests under `tests/`, and static assets under `assets/` when needed. The declared `index.js` entry point does not currently exist. Update package metadata when establishing the actual entry point.

## Build, Test, and Development Commands

Prefix shell commands with `rtk`, as required by the workspace instructions. Use `rtk proxy` for commands without a dedicated wrapper.

- `rtk proxy npm ci`: install the exact dependencies recorded in the lockfile.
- `rtk proxy npx tsx src/index.ts`: run a TypeScript entry point after creating it.
- `rtk proxy npx tsc --noEmit`: check types once TypeScript source files exist.
- `rtk proxy npx tsc`: compile using `tsconfig.json`; output directories are not configured yet.
- `rtk npm test`: currently executes a placeholder that exits with an error.

No build or development scripts are configured in `package.json` yet.

## Coding Style & Naming Conventions

Use two-space indentation, matching the configuration files. Prefer TypeScript with explicit boundary types and avoid unnecessary `any`. Preserve strict checking, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

Use camelCase for functions and variables, PascalCase for types and classes, and descriptive kebab-case module filenames. The package declares CommonJS while TypeScript uses NodeNext resolution; keep module syntax compatible with these settings. No formatter or linter is configured.

## Testing Guidelines

No test framework or coverage threshold is established. When adding tests, choose and configure a runner, replace the placeholder test script, and document execution. Prefer `tests/<module>.test.ts` filenames. Cover normal behavior, invalid inputs, and external-service failures; mock API calls for repeatable tests.

## Commit & Pull Request Guidelines

No Git history is available to establish existing conventions. Use concise, imperative commit subjects, such as `Add clip validation`. Pull requests should explain the change, link relevant issues, and report verification commands and results. Include screenshots when introducing visible UI changes.

## Security & Configuration

Keep API credentials in environment variables. Before adding local `.env` files, ensure they are ignored by Git. Provide placeholder configuration examples without real secrets, and avoid logging credentials or sensitive API payloads.
