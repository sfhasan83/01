# Windows trial installer

Builds `BAATS-ERP-Setup-<version>.exe`: a per-user installer (no admin rights) that bundles
Node.js 22 (win-x64), PostgreSQL 16 binaries (@embedded-postgres/windows-x64, wx GUI DLLs removed,
app-local VC++ runtime from the msvc-runtime wheel), the Phase 1 app with production node_modules,
and a launcher.

- `launcher.mjs`: first run creates a private cluster in `%LOCALAPPDATA%\BAATS-ERP\pgdata`
  (generated passwords in `config.json`), starts PostgreSQL on 127.0.0.1:54329, applies
  `db/migrations`, serves the API plus `console.html` on 127.0.0.1:3000 and opens the browser.
  `--stop` stops it. Migrations are applied by the launcher because `src/core/migrate.ts` uses
  `URL.pathname`, which breaks on Windows drive paths.
- `console.html`: trial web console over the `/v1` API (not the product UI).
- `baats.nsi`: NSIS script. Stage the files into the paths it references, then `makensis baats.nsi`.

The installer is unsigned, so Windows SmartScreen warns on first run.
