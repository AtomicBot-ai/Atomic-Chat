(function_declaration name: (identifier) @definition.function)
(generator_function_declaration name: (identifier) @definition.function)
(class_declaration name: (type_identifier) @definition.class)
(interface_declaration name: (type_identifier) @definition.interface)
(type_alias_declaration name: (type_identifier) @definition.type)
(enum_declaration name: (identifier) @definition.enum)
(method_definition name: (property_identifier) @definition.method)
(abstract_method_signature name: (property_identifier) @definition.method)

; `const Foo = () => {}` is how nearly every component and hook in this
; codebase is declared, so treating it as a plain constant would hide most of
; the symbols worth finding. The broader `constant` pattern below matches the
; same node; `dedupe_symbols` keeps the more specific kind.
(lexical_declaration
  (variable_declarator
    name: (identifier) @definition.function
    value: [(arrow_function) (function_expression)]))
(lexical_declaration (variable_declarator name: (identifier) @definition.constant))
