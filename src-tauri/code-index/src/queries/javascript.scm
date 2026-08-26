(function_declaration name: (identifier) @definition.function)
(generator_function_declaration name: (identifier) @definition.function)
(class_declaration name: (identifier) @definition.class)
(method_definition name: (property_identifier) @definition.method)

; See the note in typescript.scm: arrow-function constants are the common form.
(lexical_declaration
  (variable_declarator
    name: (identifier) @definition.function
    value: [(arrow_function) (function_expression)]))
(lexical_declaration (variable_declarator name: (identifier) @definition.constant))
