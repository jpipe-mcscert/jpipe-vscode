import { URI, type LangiumDocument, AstUtils, type AstNode } from 'langium';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
    isJustification,
    isTemplate,
    type Justification,
    type Load,
    type Template,
    type JustificationElement,
    type Unit
} from './generated/ast.js';
import { fsPathOf, getAllElements, qualifiedIdText } from './jpipe-utils.js';
import { byCodeUnit } from './jpipe-text.js';
import {
    anchorGlob,
    globToRegExp,
    hasUpwardSegment,
    isGlobPattern,
    GlobAnchorError,
    GlobUpwardSegmentError
} from './jpipe-glob.js';

/**
 * Directories skipped while expanding a glob. The compiler's `Files.walk` does not prune, but it
 * runs once per build whereas this runs during scope resolution, i.e. while the user types. These
 * are the same names Langium's own `WorkspaceManager.shouldIncludeEntry` refuses to descend into,
 * so a `.jd` file is not expected to live in any of them.
 */
const PRUNED_DIRECTORIES = new Set(['node_modules', 'out', '.git']);

/** Upper bound on entries visited per expansion, so a pattern near a huge tree fails loudly. */
const MAX_WALK_ENTRIES = 20_000;

/**
 * Import service for handling imports and resolving imported documents, templates, and elements.
 */
export class JpipeImportService {
    private readonly services: JpipeServices;
    private readonly logger: JpipeServerLogger;
    /** Memoised glob expansions, keyed by base directory + pattern. See `invalidateGlobCache`. */
    private readonly globCache = new Map<string, string[]>();

    public constructor(services: JpipeServices) {
        this.services = services;
        this.logger = services.logger;
    }

    /**
     * Drops memoised glob expansions. Wired to `DocumentBuilder.onUpdate` in `jpipe-module.ts`.
     *
     * Known gap: a `.jd` file created outside the editor does not trigger a document update, so a
     * pattern's match set can be stale until the next edit. The extension registers no file
     * watcher today (`synchronize.fileEvents` is unset).
     */
    invalidateGlobCache(): void {
        this.globCache.clear();
    }

    /**
     * Resolve a (possibly relative) import path to an absolute OS-native filesystem
     * path, relative to `relativeToDoc` when the path is not already absolute.
     */
    resolveFsPath(filePath: string, relativeToDoc?: LangiumDocument): string {
        if (relativeToDoc && !path.isAbsolute(filePath)) {
            // Use fsPath (native path), not URI.path — see fsPathOf docs. On Windows
            // URI.path is `/c:/...` which breaks win32 path.resolve/fs.existsSync.
            const currentDir = path.dirname(fsPathOf(relativeToDoc.uri));
            return path.resolve(currentDir, filePath);
        }
        return filePath;
    }

    /**
     * Returns the resolved absolute path of an import if the target exists (either as
     * an already-open document or a file on disk), otherwise undefined. Used by the
     * validator to flag unresolvable `load` statements without parsing them.
     */
    resolveExistingImportPath(filePath: string, relativeToDoc?: LangiumDocument): string | undefined {
        const resolvedPath = this.resolveFsPath(filePath, relativeToDoc);
        const resolvedUri = URI.file(resolvedPath);
        if (this.services.shared.workspace.LangiumDocuments.getDocument(resolvedUri)) {
            return resolvedPath;
        }
        return fs.existsSync(resolvedPath) ? resolvedPath : undefined;
    }

    /**
     * Every absolute filesystem path a `load` path resolves to, sorted.
     *
     * A literal path yields 0 or 1 entries. A glob is expanded the way `LoadResolver.expandGlob`
     * does: the pattern is anchored at its literal prefix — resolved like a literal load, so it
     * may climb out of the declaring file's directory or name an absolute location — and the
     * remainder is matched against paths relative to that anchor. The result is sorted, so the
     * outcome does not depend on filesystem enumeration order.
     *
     * @throws GlobExpansionError for a malformed pattern, a `..` surviving anchoring, or an
     * anchor that is not a directory. The validator turns each into its own diagnostic.
     */
    expandLoadPath(filePath: string, relativeToDoc?: LangiumDocument): string[] {
        if (!isGlobPattern(filePath)) {
            const resolved = this.resolveExistingImportPath(filePath, relativeToDoc);
            return resolved ? [resolved] : [];
        }

        const base = relativeToDoc
            ? path.dirname(fsPathOf(relativeToDoc.uri))
            : process.cwd();
        const cacheKey = `${base}\u0000${filePath}`;
        const cached = this.globCache.get(cacheKey);
        if (cached) return cached;

        const { prefix, pattern } = anchorGlob(filePath);
        // The literal prefix is resolved exactly like a literal load path, which is what lets a
        // pattern reach a sibling directory or an absolute location.
        const root = path.resolve(base, prefix);

        // Same order of checks as the compiler, so identical input draws an identical complaint:
        // syntax first (a malformed pattern is malformed wherever it points), then the
        // unsatisfiable `..`, then the anchor itself.
        const matcher = globToRegExp(pattern);
        if (hasUpwardSegment(pattern)) {
            throw new GlobUpwardSegmentError();
        }
        if (!this.isDirectory(root)) {
            throw new GlobAnchorError(root);
        }

        const matches: string[] = [];
        for (const file of this.walkFiles(root)) {
            // The pattern is written with `/`, so compare against a POSIX-normalised relative path
            // on every platform. Java reaches the same result on Windows by compiling `/` to `\`.
            const relative = path.relative(root, file).split(path.sep).join('/');
            if (matcher.test(relative)) {
                matches.push(file);
            }
        }
        // Code-unit order, to agree with the compiler about the order a model's files load in.
        // See `byCodeUnit` for why it is not `localeCompare`.
        matches.sort(byCodeUnit);
        this.globCache.set(cacheKey, matches);
        this.logger.debug(`Glob '${filePath}' matched ${matches.length} file(s) under ${root}`);
        return matches;
    }

    private isDirectory(target: string): boolean {
        try {
            return fs.statSync(target).isDirectory();
        } catch {
            return false;
        }
    }

    /** Every document a single `load` resolves to — more than one when its path is a glob. */
    resolveImportedDocuments(load: Load, currentDoc: LangiumDocument): LangiumDocument[] {
        let paths: string[];
        try {
            paths = this.expandLoadPath(load.path, currentDoc);
        } catch {
            // Malformed pattern: the validator reports it, resolution just yields nothing.
            return [];
        }
        const documents: LangiumDocument[] = [];
        for (const filePath of paths) {
            // A broad pattern such as `**.jd` naturally matches the declaring file. The compiler
            // calls that a circular load and contributes nothing for it (the validator reports
            // it); contribute nothing here too, rather than folding the file into its own scope.
            if (this.isSameFile(filePath, currentDoc)) continue;
            const doc = this.parseDocumentFromPath(filePath, currentDoc);
            if (doc) documents.push(doc);
        }
        return documents;
    }

    /** Whether `filePath` is the document itself — the direct circular-load case. */
    isSameFile(filePath: string, document: LangiumDocument): boolean {
        return path.resolve(filePath) === path.resolve(fsPathOf(document.uri));
    }

    /** Regular files under `dir`, recursively, skipping pruned directories. */
    private *walkFiles(dir: string): Generator<string> {
        let visited = 0;
        const stack: string[] = [dir];
        while (stack.length > 0) {
            const current = stack.pop()!;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue; // unreadable directory: skip rather than fail the whole expansion
            }
            for (const entry of entries) {
                if (++visited > MAX_WALK_ENTRIES) {
                    this.logger.warn(`Glob expansion under ${dir} exceeded ${MAX_WALK_ENTRIES} entries; results are truncated.`);
                    return;
                }
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (!PRUNED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
                        stack.push(full);
                    }
                } else if (entry.isFile()) {
                    yield full;
                }
            }
        }
    }

    parseDocumentFromPath(filePath: string, relativeToDoc?: LangiumDocument): LangiumDocument | undefined {
        const resolvedPath = this.resolveFsPath(filePath, relativeToDoc);

        const resolvedUri = URI.file(resolvedPath);
        const existingDoc = this.services.shared.workspace.LangiumDocuments.getDocument(resolvedUri);
        if (existingDoc) {
            return existingDoc;
        }

        if (!fs.existsSync(resolvedPath)) {
            this.logger.warn(`Import not found: ${resolvedPath}`);
            return undefined;
        }

        try {
            const fileContent = fs.readFileSync(resolvedPath, 'utf-8');
            const docFactory = this.services.shared.workspace.LangiumDocumentFactory;
            const doc = docFactory.fromString(fileContent, resolvedUri);
            const parser = this.services.parser.LangiumParser;
            doc.parseResult = parser.parse(fileContent);

            if (doc.parseResult.value) {
                this.setDocumentOnAllNodes(doc.parseResult.value, doc);
            }

            this.logger.debug(`Parsed import: ${resolvedPath}`);
            return doc;
        } catch (error) {
            this.logger.error(`Failed to parse document: ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    private setDocumentOnAllNodes(node: AstNode, document: LangiumDocument): void {
        const assign = (n: AstNode) => { (n as unknown as Record<string, unknown>).$document = document; };
        assign(node);
        AstUtils.streamAst(node).forEach(assign);
    }

    getTemplatesWithNamespace(
        unit: Unit,
        currentDoc: LangiumDocument
    ): Array<{ template: Template; ns: string | undefined }> {
        const result: Array<{ template: Template; ns: string | undefined }> = [];
        for (const load of unit.imports) {
            // A glob contributes every matched file, all sharing the load's namespace.
            for (const doc of this.resolveImportedDocuments(load, currentDoc)) {
                const importedUnit = doc.parseResult.value as Unit | undefined;
                if (!importedUnit) continue;
                for (const body of importedUnit.body) {
                    if (isTemplate(body)) {
                        result.push({ template: body, ns: load.namespace ?? undefined });
                    }
                }
            }
        }
        return result;
    }

    getJustificationsAndTemplatesWithNamespace(
        unit: Unit,
        currentDoc: LangiumDocument
    ): Array<{ node: Justification | Template; ns: string | undefined }> {
        const result: Array<{ node: Justification | Template; ns: string | undefined }> = [];
        for (const load of unit.imports) {
            for (const doc of this.resolveImportedDocuments(load, currentDoc)) {
                const importedUnit = doc.parseResult.value as Unit | undefined;
                if (!importedUnit) continue;
                for (const body of importedUnit.body) {
                    if (isJustification(body) || isTemplate(body)) {
                        result.push({ node: body, ns: load.namespace ?? undefined });
                    }
                }
            }
        }
        return result;
    }

    getImportedTemplates(unit: Unit, currentDoc: LangiumDocument): Template[] {
        const importedDocs = this.getTransitiveImportedDocuments(unit, currentDoc);
        const templates: Template[] = [];
        for (const doc of importedDocs) {
            const importedUnit = doc.parseResult.value as Unit | undefined;
            if (importedUnit) {
                templates.push(...this.getLocalTemplates(importedUnit));
            }
        }
        return templates;
    }

    getImportedElements(unit: Unit, currentDoc: LangiumDocument): JustificationElement[] {
        return this.getElementsFromImportsTransitive(unit, currentDoc, isJustification);
    }

    getImportedTemplateElements(unit: Unit, currentDoc: LangiumDocument): JustificationElement[] {
        return this.getElementsFromImportsTransitive(unit, currentDoc, isTemplate);
    }

    private getElementsFromImportsTransitive(
        unit: Unit,
        currentDoc: LangiumDocument,
        filterFn: (body: any) => boolean
    ): JustificationElement[] {
        const importedDocs = this.getTransitiveImportedDocuments(unit, currentDoc);
        const elements: JustificationElement[] = [];
        for (const doc of importedDocs) {
            const importedUnit = doc.parseResult.value as Unit | undefined;
            if (importedUnit) {
                elements.push(...this.getElementsFromImportedUnit(importedUnit, filterFn));
            }
        }
        return elements;
    }

    /**
     * Traverse `load` edges starting from the current unit:
     * - Start from direct loads of `currentDoc` (must be explicitly loaded by the root doc)
     * - Then follow loads found inside imported docs (transitively), resolving relative to each doc
     *
     * This is a BFS over the import graph, bounded by a visited set.
     */
    private getTransitiveImportedDocuments(unit: Unit, currentDoc: LangiumDocument): LangiumDocument[] {
        const out: LangiumDocument[] = [];
        const visited = new Set<string>();

        const enqueue: LangiumDocument[] = [];
        // Iterating `unit.imports` is itself the "explicitly loaded" check that `resolveImport`
        // used to perform by comparing paths — which a glob could not satisfy.
        for (const load of unit.imports) {
            for (const doc of this.resolveImportedDocuments(load, currentDoc)) {
                const uri = doc.uri?.toString();
                if (uri && !visited.has(uri)) {
                    visited.add(uri);
                    enqueue.push(doc);
                    out.push(doc);
                }
            }
        }

        for (const doc of enqueue) {
            const u = doc.parseResult.value as Unit | undefined;
            if (!u) continue;
            for (const load of u.imports) {
                // Resolved relative to the importing document, so nested globs work at any depth.
                for (const nextDoc of this.resolveImportedDocuments(load, doc)) {
                    const uri = nextDoc.uri?.toString();
                    if (uri && !visited.has(uri)) {
                        visited.add(uri);
                        enqueue.push(nextDoc);
                        out.push(nextDoc);
                    }
                }
            }
        }

        this.logger.debug(`BFS import traversal: ${out.length} document(s) reachable`);
        return out;
    }

    private getElementsFromImportedUnit(
        importedUnit: Unit,
        filterFn: (body: any) => boolean
    ): JustificationElement[] {
        const elements: JustificationElement[] = [];
        for (const body of importedUnit.body) {
            if (filterFn(body)) {
                if (isJustification(body) || isTemplate(body)) {
                    elements.push(...getAllElements(body));
                }
            }
        }
        return elements;
    }

    /**
     * Returns the namespace alias under which `template` was imported into `unit`,
     * or undefined if it was loaded without an alias or is local.
     */
    getNamespaceForTemplate(template: Template, unit: Unit, currentDoc: LangiumDocument): string | undefined {
        for (const load of unit.imports) {
            if (!load.namespace) continue;
            for (const doc of this.resolveImportedDocuments(load, currentDoc)) {
                const importedUnit = doc.parseResult.value as Unit | undefined;
                if (!importedUnit) continue;
                if (importedUnit.body.includes(template)) return load.namespace;
            }
        }
        return undefined;
    }

    /**
     * Returns all elements inherited by `owner` through its parent chain, each annotated
     * with the scope key to use in relations (accounting for namespace prefixes).
     *
     * Per the jpipe-compiler ADR-0012 qualified-ID scheme:
     *   - local template T    → key = T:elementId           e.g. "T:abs"
     *   - namespaced template → key = ns:templateId:elementId  e.g. "base:t:abs"
     */
    getInheritedElementsWithKeys(
        owner: Justification | Template,
        unit: Unit,
        currentDoc: LangiumDocument
    ): Array<{ element: JustificationElement; key: string; localKey: string }> {
        const result: Array<{ element: JustificationElement; key: string; localKey: string }> = [];
        const visited = new Set<Template>();
        let parent = owner.parent?.ref;
        while (parent && !visited.has(parent)) {
            visited.add(parent);
            const ns = this.getNamespaceForTemplate(parent, unit, currentDoc);
            // key includes namespace for scope resolution; localKey omits it for display.
            const prefix = ns ? `${ns}:${parent.id}:` : `${parent.id}:`;
            const localPrefix = `${parent.id}:`;
            for (const el of (parent.contents?.body ?? []) as JustificationElement[]) {
                const elId = qualifiedIdText(el.id);
                result.push({ element: el, key: prefix + elId, localKey: localPrefix + elId });
            }
            parent = parent.parent?.ref;
        }
        return result;
    }

    private getLocalTemplates(unit: Unit): Template[] {
        return unit.body.filter((b): b is Template => isTemplate(b));
    }
}
