/**
 * jPipe Language Grammar
 * 
 * Defines the syntax for the jPipe justification language. Key features:
 * - Templates: Reusable justification structures that can be implemented by justifications
 * - Justifications: Concrete implementations that can implement templates
 * - @support annotation: Marks template elements that must be overridden (like abstract methods)
 *   Syntax: @support {type} name is "label" where type is evidence|strategy|conclusion|sub-conclusion
 * - Inheritance: Both templates and justifications can implement parent templates, creating
 *   inheritance chains where elements bubble up
 * - Relations: Elements can support each other using the "supports" keyword
 */

grammar Jpipe

entry Unit:
    (body+=Justification | body+=Template | imports+=Load)*;

Load:
    'load' filePath=STRING;

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
    '@support' type=('evidence' | 'strategy' | 'conclusion' | 'sub-conclusion') name=ID 'is' label=STRING;

Relation:
    from=[JustificationElement:ID] 'supports' to=[JustificationElement:ID];

hidden terminal WS: /\s+/;
terminal ID: /[\w_]+/;
terminal STRING: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;