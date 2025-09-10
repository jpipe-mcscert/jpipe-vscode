import { AstNodeDescription, AstUtils, DefaultScopeProvider, EMPTY_SCOPE, ReferenceInfo, Scope } from "langium";
import { Body, JpipeAstType, JustificationElement, Pattern, Unit } from "./generated/ast.js";
import { dirname, join } from "node:path";

/**
 * Scope provider for jPipe
 */
export class JpipeScopeProvider extends DefaultScopeProvider {

    /**
     * Entry point for providing scope while editing
     * @param context  
     * @returns 
     */
    override getScope(context: ReferenceInfo): Scope {
        switch(context.container.$type as keyof JpipeAstType) {
            // Providing scope for editing Patterns and Justifications
            case 'Justification':
            case 'Pattern':
                if(context.property === 'parent') {
                    return this.getPatternsInScope(context);
                }
                break;
            case 'Relation':
                if (context.property === 'from' || context.property === 'to') {
                    console.log("locallyDeclaredSymbols");
                    return this.getLocallyDeclaredSymbols(context);
                }
                break;
        }
        return EMPTY_SCOPE;
    }

    /**
     * 
     * @param context Identify local symbols for 
     * @returns 
     */
    private getLocallyDeclaredSymbols(context: ReferenceInfo): Scope {
        const container = context.container.$container;
        const containerType = container?.$type;
        console.log(containerType);

        if (containerType === undefined) {
            return EMPTY_SCOPE;
        }

        let body: Body | undefined;
        switch(containerType) {
            case 'JustificationBody':
            case 'PatternBody':
                body = container as Body;
                break;
            case 'JustificationElementDeclaration':
                body = container?.$container?.$container as Body;
                break
            case 'Relation':
                body = container?.$container as Body;
                break;
            default: 
                body = undefined;
        }

        if (body === undefined) {
            return EMPTY_SCOPE;
        } else {
            const descrs = body.body.map( e => this.buildDescription(e))
            return this.createScope(descrs);
        }
    }

    /**
     * Returns the relevant patterns based on the current document contents
     * @param context 
     */
    private getPatternsInScope(context: ReferenceInfo): Scope {
        const currentDocument = AstUtils.getDocument(context.container);
        const currentDir = dirname(currentDocument.uri.path);
        const unit = currentDocument.parseResult.value as Unit;
        // Identify local patterns, exclusing self if relevant
        let localPatterns = unit.body
            .filter(e => e.$type === 'Pattern')
        if (context.container.$type === 'Pattern') {
            localPatterns = localPatterns  // no self-reference
                .filter(e => e.name !== (context.container as Pattern).name)
        }
        const locals = localPatterns.map( e => 
                this.descriptions.createDescription(e, e.name, currentDocument))
        // load imported patterns
        const uris = new Set<string>();
        for (const i of unit.imports) {
            if (i.filePath) {
                const filePath = join(currentDir, i.filePath);
                const uri = currentDocument.uri.with({ path: filePath });
                uris.add(uri.toString());
            }
        }
        const imported = this.indexManager.allElements(Pattern, uris).toArray();
        // Create final scope and return it
        const availables = locals.concat(imported);
        return this.createScope(availables);
    }

    private buildDescription(elem: JustificationElement): AstNodeDescription {
        if (elem.decl?.name === undefined) {
            return this.descriptions.createDescription(elem, "?");
        } else {
            const name = elem.decl.name;
            const type = elem.$type;
            const label = elem.decl.label;
            const d = name + ": " + label + " [" + type + "]";
            return this.descriptions.createDescription(elem, d)
        }
    }
    
}