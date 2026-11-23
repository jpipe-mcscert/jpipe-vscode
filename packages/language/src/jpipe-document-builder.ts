import { DefaultDocumentBuilder, interruptAndCheck, type DocumentState, type LangiumDocument } from 'langium';
import type { JpipeServices } from './jpipe-module.js';
import { isUnit } from './generated/ast.js';
import type { CancellationToken } from 'vscode-languageserver-protocol';

/**
 * A document builder whose build phases are announced even when a build had nothing to build.
 *
 * A request that needs the workspace in some state — `workspace/symbol`, every hierarchy request —
 * waits for the builder to announce that phase, unless the builder is already past it. Langium's
 * builder (4.4.0) skips the announcement when no document went through the phase, and only then
 * records that the phase was reached. So a request that arrives while the first build is under
 * way, in a workspace with no `.jd` file, waits for an announcement that never comes: it is never
 * answered, and the Models view, which asks exactly that as it opens, loads forever.
 *
 * The phase was reached whether or not it had documents, so it is announced either way. Listeners
 * are handed the documents that went through it, here none, which every one of them iterates.
 */
export class JpipeDocumentBuilder extends DefaultDocumentBuilder {
    /**
     * Langium checks an unchanged document again only when one of its references reaches into a
     * changed one. A `load` is a path, not a reference, yet `duplicate-model` and `load` checks
     * read what the loaded files declare. So a document that loads a changed file, directly or
     * through another, is checked again too.
     */
    protected override shouldRelink(document: LangiumDocument, changedUris: Set<string>): boolean {
        if (super.shouldRelink(document, changedUris)) return true;
        const unit = document.parseResult?.value;
        if (!isUnit(unit) || unit.imports.length === 0) return false;
        const services = this.serviceRegistry.getServices(document.uri) as JpipeServices;
        return services.references.JpipeImportService.loadsAnyOf(unit, document, changedUris);
    }


    protected override async notifyBuildPhase(
        documents: LangiumDocument[],
        state: DocumentState,
        cancelToken: CancellationToken
    ): Promise<void> {
        if (documents.length > 0) return super.notifyBuildPhase(documents, state, cancelToken);
        // One listener at a time, and none once the build is cancelled, as Langium's own builder does.
        for (const listener of this.buildPhaseListeners.get(state).slice()) {
            await interruptAndCheck(cancelToken); // NOSONAR(S9382): listeners run in order, each after the last
            await listener(documents, cancelToken); // NOSONAR(S9382)
        }
    }
}
