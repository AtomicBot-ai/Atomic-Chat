; Definitions this codebase's agent is asked to locate. Capture names encode
; the symbol kind; the captured node is always the identifier itself, so the
; symbol's name and position come straight from the capture.
(function_item name: (identifier) @definition.function)
(struct_item name: (type_identifier) @definition.struct)
(enum_item name: (type_identifier) @definition.enum)
(union_item name: (type_identifier) @definition.struct)
(trait_item name: (type_identifier) @definition.trait)
(mod_item name: (identifier) @definition.module)
(type_item name: (type_identifier) @definition.type)
(const_item name: (identifier) @definition.constant)
(static_item name: (identifier) @definition.constant)
(macro_definition name: (identifier) @definition.macro)
