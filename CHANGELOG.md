# Changelog

All notable changes to **Antigravity Usage & Speed Monitor** are documented in this file.

## [1.5.6] - 2026-11

### Added
- **7-Locale Full-Stack Localization**: Added `zh-TW`, `ja-JP`, `ko-KR`, `de-DE`, and `fr-FR` alongside `zh-CN` and `en-US` across the panel UI, CLI statusLine, standalone Web views, OAuth callback page, CSV/XLSX/Markdown exports, and repository-hosted `host-i18n/` packs (`zh-CN@1.0.3` plus 5 new locale packs).
- **Locale-Linked Multi-Currency Display (#50)**: Added `shared/currency-catalog.mjs`, `backend/fx-rates.mjs`, and `/api/fx-sync` with 20 selectable currencies (`auto` locale mapping, 24h cached Frankfurter / ExchangeRate-API keyless FX sync with offline fallback, and portable backup support).
- **Local 3-Client Session Hub, Online Deletion & Chunked Migration**: Renamed **Settings** to **Control Center**, added the **Sessions** tab (`SettingsSessionsTab.js`, `session-store.mjs`, `session-cleaner.mjs`, `session-manager.mjs`, `session-online-delete.mjs`, `SessionManagerCard.js`) with shared Desktop/CLI/Legacy IDE scanning, loopback `DeleteConversation` online deletion, offline deep cleanup with ledger privacy redaction, and 5,000-session chunked migration.
- **Cross-Platform Multi-Account Management**: Extended multi-account login, keyring vaults (`account-keyring-store.mjs`, `account-switch-posix-worker.mjs`), native binary OAuth extraction (ELF64 / Mach-O / Windows ARM64), and switching across Windows, macOS Keychain, Linux `secret-tool`/passphrase vault, and WSL2.
- **Developer Options Gate, Large Sparkline Metrics & Remaining Quota Display (#52, #55)**: Added non-portable two-stage `developerModeEnabled` / `riskyFeaturesEnabled` gate for high-risk Account & Model Context surfaces, responsive large sparkline metric cards (`overviewMetricStyle`, `hoverMetricStyle`), and `quotaDisplayMode` (`used` / `remaining`) synced across Overview and Hover previews.
- **Direct Canvas Drag-Sorting, IDE Remote-SSH & CI Matrix**: Enabled direct drag-to-reorder on all Structure preview canvases (`EditableSlotList.js`, `domPatch.js`), added host launch isolation & Antigravity IDE Remote-SSH discovery (`devtools-port-probe.mjs`, `ide-remote-ssh.mjs`), progressive non-blocking trajectory cache rebuild, reverted-step usage retention, and a 3-OS GitHub Actions test matrix.

### Fixed
- **Host UI Translation Exemptions (#54)**: Exempted AI replies, KaTeX math formulas, code/diff viewers, terminals, and lowercase prose words across frontend/backend skip configs, added SemVer anti-downgrade guard, and updated bundled `zh-CN` pack to `1.0.3`.
- **Non-Chinese Locale Leaks & Document Localization (#44, #49)**: Switched manifest defaults to neutral English and synchronized `<html lang>`, `document.title`, standalone Web/Token auth pages, and unknown quota pool / export labels with active locale.
- **Deleted Local Session Picker Visibility (#39)**: Tracked local directory readability and scan completeness in `local-scanner.mjs` to hide confirmed-missing and archived local sessions from the conversation picker while preserving SQLite ledger usage stats and restoring automatically without double counting.
- **One-Shot Headless CLI Lease & Dominant Model ShortName (#45, #46)**: Prevented `-p` / `--print` headless CLI runs from hijacking bridge leases or detaching the desktop capsule on sibling exits, and resolved dominant multi-tier model short names by call count.
- **External Quota Detection, Host Theme/Font Sync & UI Layout**: Eliminated false solo external-usage triggers (`quota-reservation.mjs` high-usage self-healing, scan-lag / 5h-only lease / cold-start & stacked-lease guards), preserved host theme/fonts across plugin restarts, and fixed virtual step table width locking, transient `cdp_unreachable` alerts, empty `.db-wal` migration timestamps, and lingering login notices.

## [1.5.5] - 2026-11

### Added
- **Antigravity Host UI Localization & Layered Language Packs**: Added `backend/host-i18n/` (`pack-manager.mjs`, `runtime-translator.mjs`, `http-fetch.mjs`, `index.mjs`), `shared/host-i18n-protocol.mjs`, `HostI18nCard.js`, and repository-hosted `host-i18n/` (`zh-CN@1.0.0`, excluded from Release ZIP) with SHA-256 verification, offline light/deep tier switching, missing UI string collector, loopback-only `/api/host-i18n` endpoints, and lossless CDP DOM translation.
- **Windows Multi-Account Switching, Passphrase Vault & Quota Trend Chart**: Added loopback PKCE browser OAuth login (`account-login.mjs`), runtime native binary OAuth extraction (`account-oauth.mjs`), optional `scrypt + AES-256-GCM` secondary passphrase vault (`account-vault-crypto.mjs`) over DPAPI, background backup-account quota refresh with Ultra `5x / 20x` detection, and collinear-compressed multi-account quota history & trend chart (`account-quota-history.mjs`, `AccountQuotaTrendCard.js`).
- **Incremental SQLite Trajectory Ledger**: Added `trajectory-sqlite-ledger.mjs` (short-lived WAL `trajectory_store.sqlite` + remote `ssh-*.sqlite`) with automatic `.json` → `.bak` migration, `O(delta)` step UPSERT, undo truncation, 64-session hot LRU, corrupt-DB self-healing, and permanent archived-session preservation.
- **Built-In AI Image Generation Detection & Independent Pricing**: Decoded `GenerateImage` (`step_payload 140.2.6`) and PNG/JPEG/WebP headers for `0.5K / 1K / 2K / 4K` tier pricing and timing isolated from text LLM speed/context metrics.
- **3-Tier Weekly Capacity Estimates, 4-Mode LED Heatmap & Sub-Hour Buckets**: Filtered external/family-group usage from quota reservations, added 3-tier weekly pool capacity estimates, added `1m / 5m / 15m` sub-hour trend buckets, 4-mode (`day / week / month / total`) LED heatmap switcher, per-pool cycle filter, and unified chart motion engine (`chartMotion.js`).

### Fixed
- **SQLite Schema-Init Lock Guard & `.pb` Fallback Recovery (#41)**: Added lock-free 100-byte SQLite header readiness gate (`isSqliteDbReadyForRead`) and shared `transcript-fallback.mjs` to recover empty-shell `.db` + encrypted `.pb` sessions, subagent refs, and CLI statusLine metrics.
- **Antigravity IDE Dual-Mount Route Probing (#42)**: Added parallel short-timeout read-only DOM route probing across IDE chat iframes with UUID validation and early abort.
- **Floating Task Panel Typography & Spacing Parity**: Mirrored host `--font-sans` / `--font-mono` onto `portalHost`, unified Shadow host variable-font resets, and aligned `.wm-multi-panel` width, card row gap, and Modern UI bottom padding with the sidebar.
- **Proxy Hardening, Native Web Downloads & UI Polish**: Added SOCKS5/SOCKS5h & authenticated CONNECT tunnels with Keep-Alive pooling and crash recovery, native browser downloads for standalone Web exports, Excel 32,767-char truncation, subagent migration filtering, undo context-breakdown preservation, virtual-scroll column width locking, and hover-flicker fixes.

## [1.5.4] - 2026-11

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
