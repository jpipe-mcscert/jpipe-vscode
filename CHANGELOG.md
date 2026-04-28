## Changelog

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
