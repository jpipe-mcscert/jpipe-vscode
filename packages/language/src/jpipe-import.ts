import { URI, type LangiumDocument, AstUtils, type AstNode } from 'langium';
import type { JpipeServices } from './jpipe-module.js';
import type { JpipeServerLogger } from './jpipe-logger.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
    isJustification,
    isLoad,
    isTemplate,
    type Justification,
    type Load,
    type Template,
    type JustificationElement,
    type Unit
} from './generated/ast.js';
import { fsPathOf, getAllElements, qualifiedIdText } from './jpipe-utils.js';
import { byCodeUnit } from './jpipe-text.js';
import { messageOf } from './jpipe-errors.js';
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

/** A model the compiler reads when it builds a file, under the name it gives it there. */
export interface ModelDeclaration {
    /** `T`, or `lib:T` for a model of a file loaded `as lib`. */
    readonly name: string;
    readonly model: Justification | Template;
    readonly document: LangiumDocument;
    /** The `load` of the built file that brought the model in; `undefined` for the file's own. */
    readonly via?: Load;
}

/**
 * Import service for handling imports and resolving imported documents, templates, and elements.
 */
export class JpipeImportService {
    private readonly services: JpipeServices;
    private readonly logger: JpipeServerLogger;
    /** Memoised glob expansions, keyed by base directory + pattern. See `invalidateGlobCache`. */
    private readonly globCache = new Map<string, string[]>();
    /**
     * Files parsed from disk because no open document holds them, keyed by resolved path, with
     * the file's size and modification time when it was read. See `parseDocumentFromPath`.
     */
    private readonly shadowDocuments = new Map<string, { document: LangiumDocument; stamp: string }>();

    public constructor(services: JpipeServices) {
        this.services = services;
        this.logger = services.logger;
    }

    /**
     * Drops memoised glob expansions. See `invalidateCaches`.
     */
    invalidateGlobCache(): void {
        this.globCache.clear();
    }

    /**
     * Called on every document update (`DocumentBuilder.onUpdate`, wired in `jpipe-module.ts`).
     *
     * Drops the memoised glob expansions, and unlinks every file parsed from disk without
     * reparsing it. Its nodes stay the ones other documents point at, which is what the parse is
     * kept for, while its own references, such as a closed `middle.jd`'s `implements` into
     * `base.jd`, are resolved again against the files as they now are. Without this, editing
     * `base.jd` left `middle.jd` pointing at the version it first resolved.
     *
     * Known gap: a `.jd` file created or changed outside the editor does not trigger a document
     * update, so a pattern's match set, or what a closed file's references point at, can be stale
     * until the next edit. The extension registers no file watcher today (`synchronize.fileEvents`
     * is unset).
     */
    invalidateCaches(): void {
        this.invalidateGlobCache();
        const linker = this.services.references.Linker;
        for (const { document } of this.shadowDocuments.values()) {
            linker.unlink(document);
        }
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

    /**
     * The document for a loaded file: the open one if there is one, otherwise a parse of the file
     * on disk.
     *
     * A file parsed from disk is parsed **once for each version of it on disk**, and every caller
     * gets the same document. Callers compare AST nodes by identity — whether a template belongs
     * to the unit a `load` brought in decides the alias its elements are keyed under — and two
     * parses of one file share no node. Parsing on every call made `lib:T:s` fail to resolve
     * whenever the file it reached into was not open (#37).
     *
     * The parse is kept across builds, not dropped on each document update: a document that an
     * update does not relink still holds references into it, and a fresh parse would break them
     * the same way. It is read again only when the file's stamp changes (`stampOf`), which is also
     * what picks up a change made outside the editor, such as a `git checkout`.
     */
    parseDocumentFromPath(filePath: string, relativeToDoc?: LangiumDocument): LangiumDocument | undefined {
        const resolvedPath = this.resolveFsPath(filePath, relativeToDoc);

        const resolvedUri = URI.file(resolvedPath);
        const existingDoc = this.services.shared.workspace.LangiumDocuments.getDocument(resolvedUri);
        if (existingDoc) {
            // The open document is the file now. What pointed into the old parse is relinked by
            // the update that opened it, which reports the file's URI as changed.
            this.shadowDocuments.delete(resolvedPath);
            return existingDoc;
        }
        const stamp = this.stampOf(resolvedPath);
        if (stamp === undefined) {
            this.shadowDocuments.delete(resolvedPath);
            this.logger.warn(`Import not found: ${resolvedPath}`);
            return undefined;
        }
        const shadow = this.shadowDocuments.get(resolvedPath);
        if (shadow?.stamp === stamp) {
            return shadow.document;
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
            this.shadowDocuments.set(resolvedPath, { document: doc, stamp });
            return doc;
        } catch (error) {
            this.logger.error(`Failed to parse document: ${resolvedPath}: ${messageOf(error)}`);
            return undefined;
        }
    }

    /**
     * What tells one version of a file on disk from the next, or `undefined` if it is not a file.
     *
     * Size and modification time alone miss a same-size edit within one tick of a coarse clock
     * (FAT, some network mounts), or a tool that restores the modification time. The change time
     * cannot be set back, and a file replaced rather than written in place gets a new inode.
     */
    private stampOf(filePath: string): string | undefined {
        try {
            const stat = fs.statSync(filePath);
            return stat.isFile() ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : undefined;
        } catch {
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
     * Every model the compiler reads when it builds `currentDoc`, in the order it reads them.
     *
     * The compiler's `LoadResolver` splices a loaded file's commands in where its `load` is, so a
     * file's models and loads count in the order they are written, and a loaded file's models
     * where it is loaded. A file is read once under each namespace, the first time it is met
     * there (`LoadResolver.expandOne`): one that two files load is not read twice, while one also
     * loaded `as lib` is read again, its models named `lib:T`, as are those of the files it loads
     * in turn. A file is known by its real path, so a link or another spelling of its name is
     * the same file, as the compiler's `identity` has it. This is the order in which
     * `DuplicateModelFilter` decides which declaration is first.
     */
    modelDeclarations(unit: Unit, currentDoc: LangiumDocument): ModelDeclaration[] {
        const declarations: ModelDeclaration[] = [];
        const root = identity(fsPathOf(currentDoc.uri));
        // A file is read again under another namespace, whose names its models then carry.
        const read = new Set<string>();
        // The files being read, root first. One loaded again below itself is a cyclic load, which
        // the compiler refuses outright and the validator reports; under a new namespace at each
        // turn it would otherwise never end.
        const reading = new Set<string>([root]);
        const walk = (current: Unit, document: LangiumDocument, prefix: string | undefined, via: Load | undefined): void => {
            const items = [...current.body, ...current.imports]
                .sort((a, b) => (a.$cstNode?.offset ?? 0) - (b.$cstNode?.offset ?? 0));
            for (const item of items) {
                if (!isLoad(item)) {
                    // A model still being typed has no name yet, and so clashes with nothing.
                    if (item.id) declarations.push({ name: qualify(prefix, item.id), model: item, document, via });
                    continue;
                }
                const namespace = item.namespace ? qualify(prefix, item.namespace) : prefix;
                for (const loaded of this.resolveImportedDocuments(item, document)) {
                    const file = identity(fsPathOf(loaded.uri));
                    const key = `${file}|${namespace ?? ''}`;
                    const loadedUnit = loaded.parseResult.value as Unit | undefined;
                    if (reading.has(file) || read.has(key) || !loadedUnit) continue;
                    read.add(key);
                    reading.add(file);
                    walk(loadedUnit, loaded, namespace, via ?? item);
                    reading.delete(file);
                }
            }
        };
        walk(unit, currentDoc, undefined, undefined);
        return declarations;
    }

    /**
     * Whether a change to one of `uris` can change what `unit` loads, directly or through
     * another file: whether one is a file a literal `load` names, existing or not, so that
     * deleting or creating it counts, or lies under the directory a pattern is matched in, so
     * that a file added to or removed from its matches counts too.
     */
    loadsAnyOf(unit: Unit, currentDoc: LangiumDocument, uris: ReadonlySet<string>): boolean {
        // Asked of every document with a `load`, with the same set, on each update.
        let changed = this.changedFiles.get(uris);
        if (!changed) {
            changed = [...uris].map(uri => comparable(identity(fsPathOf(URI.parse(uri)))));
            this.changedFiles.set(uris, changed);
        }
        const files = changed;
        const reaches = (load: Load, document: LangiumDocument): boolean => {
            const base = path.dirname(fsPathOf(document.uri));
            if (!isGlobPattern(load.path)) {
                return files.includes(comparable(identity(path.resolve(base, load.path))));
            }
            let anchor: string;
            try {
                anchor = comparable(identity(path.resolve(base, anchorGlob(load.path).prefix)));
            } catch {
                return false; // a malformed pattern matches nothing, whatever changes
            }
            const under = anchor.endsWith(path.sep) ? anchor : anchor + path.sep;
            return files.some(file => file.startsWith(under));
        };
        const loads = (current: Unit | undefined, document: LangiumDocument) =>
            (current?.imports ?? []).some(load => reaches(load, document));
        // The file's own loads first: the files they reach are walked only when none matches.
        return loads(unit, currentDoc)
            || this.getTransitiveImportedDocuments(unit, currentDoc)
                .some(document => loads(document.parseResult.value as Unit | undefined, document));
    }

    /** What `loadsAnyOf` compares a set of changed URIs as, worked out once per set. */
    private readonly changedFiles = new WeakMap<ReadonlySet<string>, string[]>();

    /**
     * The documents `unit` loads, directly or through another file, each once: a BFS over `load`
     * edges, from the loads of `currentDoc`, then those inside each loaded file, each resolved
     * relative to the file it is written in, so nested globs work at any depth. Iterating
     * `unit.imports` is itself the "explicitly loaded" check.
     */
    getTransitiveImportedDocuments(unit: Unit, currentDoc: LangiumDocument): LangiumDocument[] {
        const out: LangiumDocument[] = [];
        const visited = new Set<string>();
        const queue: Array<{ unit: Unit | undefined; document: LangiumDocument }> = [{ unit, document: currentDoc }];
        for (const { unit: current, document } of queue) {
            const loaded = (current?.imports ?? []).flatMap(load => this.resolveImportedDocuments(load, document));
            for (const next of loaded) {
                const uri = next.uri?.toString();
                if (!uri || visited.has(uri)) continue;
                visited.add(uri);
                out.push(next);
                queue.push({ unit: next.parseResult.value as Unit | undefined, document: next });
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

/** `name` under `prefix`, the namespace a file was loaded under: `lib:T`. */
function qualify(prefix: string | undefined, name: string): string {
    return prefix ? `${prefix}:${name}` : name;
}

/**
 * The file `filePath` names, whatever the spelling: its real path, so that a link or a name in
 * another case on a case-insensitive disk is the same file, as in the compiler's
 * `LoadResolver.identity`.
 */
function identity(filePath: string, links = 0): string {
    const absolute = path.resolve(filePath);
    try {
        return fs.realpathSync.native(absolute);
    } catch {
        // A link whose target was just deleted is still the file it named: the deletion is
        // reported as the target's, and the link has to compare equal to it.
        try {
            const target = fs.readlinkSync(absolute);
            if (links < 8) return identity(path.resolve(path.dirname(absolute), target), links + 1);
        } catch {
            // not a link
        }
        // A file that does not exist, deleted or not yet created, is known by the real path of
        // its directory, so that it compares equal to itself before and after.
        try {
            return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
        } catch {
            return absolute;
        }
    }
}

/**
 * A path as a case-insensitive disk compares it, macOS and Windows by default: a file loaded as
 * `Lib.jd` and reported as `lib.jd` is one file. A file that exists is already spelled as on disk
 * by `identity`; one that was just deleted is not.
 */
function comparable(filePath: string): string {
    return process.platform === 'darwin' || process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

/** What two spellings of one file compare equal as: its real path, cased as its disk compares names. */
export function fileKey(filePath: string): string {
    return comparable(identity(filePath));
}
