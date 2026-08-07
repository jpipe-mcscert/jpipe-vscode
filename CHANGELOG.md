## Changelog

### v1.4.0 (Unreleased)
- Leader: Sébastien Mosser
  - Features:
    - **Glob patterns in `load`:** The compiler now accepts patterns such as `load "models/*.jd"`, and so does the editor — no more spurious "cannot resolve load path" on a line that builds cleanly. Templates pulled in by a pattern resolve for completion and `implements` just like a single file, and `as` puts every matched file under the one namespace. Note that `**` follows Java's rules, as the compiler does: `models/**.jd` matches every depth *including* the top level, while `models/**/*.jd` matches nested files only
    - **See what a pattern matched:** Hover a glob to get the list of files it resolved to, each a link you can click through to. A pattern that matches nothing, or that is malformed, is reported with the same wording the compiler uses
    - **Truly silent exclusions:** What you exclude from validation now produces no errors *and* no warnings — previously every file in an excluded folder still reported "this file is in an excluded directory". A folder of deliberately-broken counter-examples no longer fills the Problems panel, which is what compiler developers need
    - **Exclude a single file, not just a folder:** A lone counter-example living among good models can be silenced on its own, without excluding everything around it
    - **You can see what is excluded:** Excluded items are dimmed and marked with a `⊘` badge in the Explorer, on editor tabs and in Open Editors — so a file that isn't being checked always says so, without costing you a diagnostic. Only `.jd` files and the folders holding them are marked; a README sitting next to your counter-examples is left alone
    - **Right-click to exclude:** Exclude a folder or a `.jd` file straight from the Explorer, or from the editor's jPipe menu, and put it back the same way. A new "Remove Excluded Path" command drops an entry without hand-editing your settings
    - **Changes apply immediately:** Excluding or re-including something now takes effect at once — the "reload the window to apply" step is gone
  - Changed:
    - The "Excluded Directories" setting is now **"Excluded Paths"**, since it accepts individual files as well as folders. Your existing setting keeps working and needs no migration; it is simply shown as deprecated
  - Bug Fixes:
    - A blank entry in the exclusions setting no longer silences validation for the entire workspace
    - Exclusions are re-resolved when workspace folders are added or removed

### v1.3.0 (2026-07-16)
- Leader: Sébastien Mosser
  - Features:
    - **No-install setup:** You can now let the extension fetch and update the jPipe compiler for you, straight from GitHub Releases — no manual JAR downloads. Pick a version from a list that shows each release's date. Especially handy on Windows (closes #13)
    - **Choose how the compiler runs:** A single "execution mode" setting lets you use a `jpipe` command on your PATH, point at your own JAR, or let the extension manage it — with clearer messages when the compiler is missing or misconfigured
    - **Automatic update checks:** In managed mode the extension can check for newer compiler releases on a schedule you control, and optionally include pre-releases
    - **Better environment control:** New settings for a compiler timeout, extra Java (JVM) arguments, and additional folders to search for tools like `python3` and `dot` when they aren't on your PATH
    - **One-click export:** A new "Export" command uses your preferred format and can open the result automatically. Added JPEG, DOT, Python, and JPIPE to the download options
    - **Installation check** now tells you which compiler it's actually using
    - **Tidier settings page:** Options are grouped into clear sections — Compiler, Managed Compiler, Export, Validation, and Logging
  - Bug Fixes:
    - Hardened how the compiler is launched (no shell-injection, correct PATH handling, validated download source) and made update checks apply only in managed mode, with correct pre-release handling
    - Removed a couple of icons that weren't rendering next to settings links
  - Documentation:
    - Corrected the version-bump steps in the README so releases no longer hit an npm 404
  - Maintenance:
    - **Now requires VS Code 1.85 or newer** (November 2023) — older editors are no longer supported
    - Refreshed the build and test toolchain and cleared several security advisories in it (development-only; nothing that ships to users was affected)
    - Removed an unused dependency to keep the download smaller

### v1.2.0 (2026-07-15)
- Leader: Sébastien Mosser
  - Features:
    - **Language Server:** Surface unresolved `load` paths as diagnostics instead of failing silently
    - **Language Server:** Go-to-definition on a `load "..."` path navigates to the loaded document
    - **Extension:** Replace the diagnostic-view toolbar icon (magnifying glass → clipboard) to avoid confusion with the adjacent zoom controls
  - Bug Fixes:
    - **Language Server:** Resolve `load` imports via `URI.fsPath` so they work on Windows (drive-letter paths were malformed under `URI.path`, silently breaking imports and cross-references)
    - **Extension:** Diagnostic-view toggle no longer freezes when a render fails — resolve the document before switching modes and retain last-good render metadata on error
    - **Extension:** Add a 30s timeout to CLI/JAR invocations so a hung compiler can't freeze the preview panel

### v1.1.1 (2026-05-08)
- Leader: Sébastien Mosser
  - Features:
    - **Extension:** Route compiler errors to the jPipe output channel instead of notification popups
    - **Extension:** Gate the output-channel reveal on the configured `jpipe.logLevel` (panel no longer opens with no visible message)

### v1.1.0 (2026-04-28)
- Leader: Sébastien Mosser
  - Features:
    - **Language Server:** Implement qualified names, hierarchical outline, and namespace-aware scoping
    - **Language Server:** Remodel composition operators with proper grammar, scope, and completion
    - **Language Server:** Improve completion for `supports` relations, operator calls, and load paths
    - **Language Server:** Redesign outline with namespace grouping; prefix inherited elements with their source template id
    - **Language Server:** Semantic token provider with 5 keyword groups and TextMate scope fallbacks
    - **Extension:** Add `jpipe.excludedDirectories` setting to suppress validation in selected directories
    - **Extension:** Lock preview panel group using the tabGroups API
    - **Extension:** Grouped context menu, hover labels, shield logo, and export fallback
    - **CI/CD:** Overhaul pipelines with deduplication and automated release
  - Bug Fixes:
    - Restore last diagram when switching back from diagnostic mode
    - Fix silent early return in `updatePreview` when cursor is outside any diagram
    - Fix panel lock via resolved `viewColumn`; pass diagram name on fallback export

### v1.0.2 (2026-04-26)
- Leader: Sébastien Mosser
  - Bug Fixes:
    - Fix broken URL in README
    - Fix inconsistent version numbers across `package.json` files
  - Documentation:
    - Document version bump procedure in README

### v1.0.1 (2026-04-26)
- Leader: Sébastien Mosser
  - Contributors: Andrew Bovbel
  - Features:
    - **Grammar:** Migrated Langium grammar to match ANTLR grammar parity
    - **Grammar:** Support namespace-qualified `implements` with correct override validation
    - **Grammar:** Convert `Relation` `from`/`to` from qualified identifiers to cross-references
    - **Grammar:** Bumped to Langium 4.2
    - **Language Server:** Import scoping for `load` statements (transitive, BFS-based)
    - **Language Server:** `implements`-chain scoping for relations in justifications and templates
    - **Language Server:** Improved completion for nodes with labels and recursive file loading
    - **Language Server:** Structured logging with configurable log level
    - **Extension:** Overhauled image generation pipeline and preview panel
    - **Extension:** Diagnostic view toggle in the preview panel
    - **Extension:** Zoom controls via toolbar buttons and `+`/`-` keys
    - **Extension:** Preview panel diagram button and reopen fix
  - Bug Fixes:
    - Fix multi-level override validation for inherited abstract supports
    - Fix SVG node highlighting to use id-based lookup (not label)
    - Fix infinite loading loop when resolving transitive imports
    - Fix error notifications with reload on generation failure

### v0.2.10 (2025-06-21)
- Leader:  Sébastien Mosser
  - Features:
    - New compiler release
    - Add export format (dot, jpipe, runner)
    - slightly change graphical rendering (using different shapes and not only colors)

### v0.2.9 (2025-03-05)
- Leader: Cass Braun
  - Features:
    - Added go to definition from SVG
    - Updated composition in langium grammar

### v0.2.8 (2025-03-05)
- Leader: Sébastien Mosser
  - Features:
    - Fixing path issues for Windows
    - Added goToDefinition from SVG to textEditor

### v0.2.7 (2025-02-24)
- Leader: Cass Braun
  - Features:
    - Added ability to activate and deactivate installation checks on startup for Java and GraphViz
    - Added instruction description on code completion prompt
    - Fixed error with conclusion validation when justification implements pattern
    - Added QuickFix to add blank @support statement to pattern
    - Added QuickFix to add blank conclusion into pattern
    - Added validation for conclusion in pattern
    - Added completion support for variables loaded from other files
    - Added ability to set java version in settings

### v0.2.6 (2025-01-29)
- Leader: Sébastien Mosser
  - Features:
    - Support file path coming from windows

### v0.2.5 (2025-01-29)
- Leader: Sébastien Mosser
  - Features:
    - Fix path issues when they contain space (bugfix issue #99)

### v0.2.4 (2025-01-20)
- Leader: Sébastien Mosser
  - Features:
    - Fix dependencies vulnerabilities
    - Update to latest version of Langium

### v0.2.3 (2025-01-20)
- Leader: Cass Braun
  - Features:
    - Added ability to activate and deactivate installation checks on startup for Java and GraphViz
    - Added QuickFix to remove implemented element of justification, pattern, and composition when there is incorrect syntax
    - Added validation to throw error when there is no conclusion found in a justification diagram
    - Added QuickFix to add a conclusion to a justification diagram
    - Added GoToDefintion for load statements
 
### v0.2.2 (2024-08-13)
- Leader: Cass Braun
  - Features:
    - Added QuickFix to change justification to pattern if it includes an instruction labelled @support
    - Added QuickFix to change pattern to justification if it includes no instruction labelled @support
    - Added QuickFix to remove support statement line if it's instruction types do not match
    - Added QuickFix to add relative load statements for unresolved references
    - Added support for relative load statements
    - Added validation for declaration implementation rules

### v0.2.2 (2024-08-06)
- Leader: Cass Braun
  - Features:
    - Added patterns and compositions to grammar with basic language support
    - Added improved completion for justification diagrams and compositions
    - Added basic quick fix

### v0.2.0 (2024-07-19)

  - Leader: Cass Braun
  - Features:
    - New language server using Langium instead of LEVER
    - Downloading files with right click, as PNG or SVG
    - Configuration settings to select which JAR file to be used


### v0.1.0 (2024-04-20)

  - Leader: Nirmal Chaudhari
  - Features:
    - Language server for jPipe, using LEVER
    - VS Code extension with syntax highligthing
    - Preview of diagrams
