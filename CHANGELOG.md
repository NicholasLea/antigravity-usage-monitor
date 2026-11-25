# Changelog

All notable changes to **Antigravity Usage & Speed Monitor** are documented in this file.

## [1.5.4] - Unreleased

### Added
- **Local CloudCode Proxy & Dual Context-Window Controls**: Added `cloudcode-proxy.mjs` loopback reverse proxy (`SetCloudCodeURL`) to synchronize custom per-model context window limits to non-`self` subagents and Swarm workers alongside independent `contextWindowMainEnabled` / `contextWindowSwarmEnabled` toggles.
- **Experimental Quota Lease Reservation Estimator**: Added `quota-reservation.mjs` 5h/weekly dual-bucket in-flight quota lease tracking, FIFO settlement, delayed refund confirmation, outlier-filtered rolling median rate calibration, violet bar indicator, and `GET /api/quota-reservation/log`.
- **Native Multi-Sheet `.xlsx` & Markdown Exports**: Added zero-dependency OOXML workbook builder (`xlsxBuilder.js`) and localized multi-sheet Excel / Markdown report exports with local `~/Downloads` save and one-click file manager reveal toast.
- **Step Diagnostic Drawer & Live Filtering**: Added click-to-inspect `StepDiagnosticDrawer` (timing waterfall, token/cost breakdown, 9-kind V4 `anomaly.events` list, Markdown copy), live multi-term step search, and danger-tier diagnostic filter chips.
- **Workspace Cost Attribution & Session Migration**: Added **Projects (Workspaces)** cost ranking tab, session project tags, portable JSON settings backup/import, and opt-in cross-client session migration/cloning (`CLI ↔ Desktop/IDE` and `Legacy IDE`) with isolated UUID rewriting.
- **CLI `statusLine` Gauge Styles & JSON Output**: Added `--style pill|bar|compact`, `--preset compact|balanced|full`, and single-line `--json` snapshot output for external prompt/bar integrations.

### Changed & Optimized
- **Hot-Path Performance (P1)**: Made `trajectoryCache` lazy via `createTrajectoryCacheStore` and added tail-row (`LIMIT 16`) SQLite reads for `cli-statusline.mjs` (`~419ms → <60ms`); skipped redundant per-poll WAL `statSync` on unchanged `IDLE` sessions; switched `cloudcode-proxy` Windows system proxy lookup to async `execFile` with TTL caching; deferred overlay `App()` instantiation until first popover open; coalesced host `MutationObserver` via `requestAnimationFrame`; shared `adoptedStyleSheets` across overlay portals and cached chart `DOMRect` on hover.
- **Shared Primitives & Modular Architecture (P2–P3)**: Extracted `fs-atomic.mjs`, `trajectory-cache-store.mjs`, `workspace-uri.mjs`, `prompt-clean.mjs`, `windows-shortcut-provision.ps1`, `ToggleSwitch.js` (cutting `SettingsView` `ResizeObserver` count by ~59%), `SearchInput.js`, `StepDiagnosticDrawer.js`, `ConsumptionBreakdownRows.js`, `stepChartMath.js`, and `overlayHostAnchors.js`; upgraded `build-bundle.mjs` regex-after-condition-paren lexer and inner-IIFE `import/export { a as b }` alias support.

### Fixed
- **Telemetry & Inspector Accuracy (P0)**: Unified step selection keys so clicking any step reliably opens the diagnostic drawer; preserved V4 `nativeStreamSec`, `thinkingDurationSec`, and `hasToolCalls` across step projections; fixed `reportExporter.js` and `stepInspector.js` duration/waterfall fields and `anomaly.events` rendering; computed merged model average speed from exact `speedSummary.{tokens, seconds}` harmonic totals; honored `ANTIGRAVITY_GEMINI_DIR` override and cleaned up `multiRunningWidget` on overlay disposal.

## [1.5.3] - 2026-04

### Added & Changed
- Graduated borderless **Modern UI** to default, defaulted language to host/system (`auto`), and unified token breakdown ordering and flat tooltip cards.
- Added SSH Remote multi-window isolation (`endpoint-registry.mjs`) with per-endpoint trajectory/quota caches and RPC routing.
- Added support for Opus 5.5 Orchestrator (`Neon` variants) and prevented unknown future variants from misrouting to Carbon pools.
- Fixed 5-hour quota cycle boundary accounting and macOS host relaunch ancestor process matching.

## [1.5.2] - 2026-03

### Added & Changed
- Added runtime-only whitelist Release ZIP packager (`pack-release-zip.mjs`), Native Swarm mode worker telemetry, 9-category step anomaly diagnostics, virtualized large step tables (`>80` rows), and pruned `scope=consumption` / `scope=conversation` fast paths.
- Hardened Desktop `2.33.0+` launcher auto-provisioning and out-of-job 1-click host relaunch across Windows (UIPI-safe user relaunch + on-demand UAC), macOS, and Linux (`.desktop` / AppImage).

## [1.5.1] - 2026-03

### Added & Changed
- Added hybrid SQLite + WAL direct reader, `384k` context window preset, time-phased promotional model pricing, scalable `--fs-*` typography tokens, and isolated `sidecar-worker.mjs` hot-reloadable runtime.
