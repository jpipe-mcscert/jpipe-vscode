/**
 * jPipe Language Grammar
 * 
 * Defines the syntax for the jPipe justification language. Key features:
 * - Templates: Reusable justification structures that can be implemented by justifications
 * - Justifications: Concrete implementations that can implement templates
 * - @support annotation: Marks template elements that must be overridden (like abstract methods)
 *   Syntax: @support name is "label"
 *   @support elements can only be refined by evidence or sub-conclusion in justifications
 * - Inheritance: Both templates and justifications can implement parent templates, creating
 *   inheritance chains where elements bubble up
 * - Relations: Elements can support each other using the "supports" keyword
 */

grammar Jpipe

entry Unit:
    (body+=Justification | body+=Template | imports+=Load | body += Composition)*;

Load:
    'load' filePath=STRING;

type Model = Justification | Template | OperatorCall

Justification: 
    'justification' name=ID ('implements' parent=[Template:ID])? '{' contents=JustificationBody '}';

Template: 
    'template' name=ID ('implements' parent=[Template:ID])? '{' contents=TemplateBody '}';

type Body = JustificationBody | TemplateBody

JustificationBody:
    (body+=Evidence | body+=Strategy | body+=SubConclusion | body+=Conclusion | rels+=Relation)+;

TemplateBody:
    (body+=Evidence | body+=Strategy | body+=SubConclusion | body+=Conclusion | body+=AbstractSupport | rels+=Relation)+;

type JustificationElement = Evidence | Strategy | SubConclusion | Conclusion | AbstractSupport

Evidence: 
    'evidence' name=ID 'is' label=STRING;

Conclusion: 
    'conclusion' name=ID 'is' label=STRING;

Strategy:
    'strategy' name=ID 'is' label=STRING;

SubConclusion:
    'sub-conclusion' name=ID 'is' label=STRING;

AbstractSupport:
    '@support' name=ID 'is' label=STRING;

Relation:
    from=[JustificationElement:ID] 'supports' to=[JustificationElement:ID];


Composition:
    'composition' '{' (body+=OperatorCall)+ '}';

OperatorCall:
    kind=('justification'|'template') name=ID 'is' operator=('refine' | 'assemble') '(' operands+=[Model:ID] (',' operands+=[Model:ID])* ')' '{' config+=OperatorConfig+ '}';

OperatorConfig:
    key=ID ':' value=STRING;


hidden terminal WS: /\s+/;
terminal ID: /[\w_]+/;
terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;


hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;