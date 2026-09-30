// Included only by documents.yar.

private rule example_document_keywords {
    meta:
        description = "Macro entry points an office document can be opened into"
    strings:
        $auto = "AutoOpen" ascii nocase
        $open = "Document_Open" ascii nocase
        $shell = "Shell(" ascii nocase
    condition:
        any of them
}
