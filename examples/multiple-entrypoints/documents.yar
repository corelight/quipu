// Quipu example: multiple entrypoints.
//
// 1. Rules > Compile Workspace (Ctrl+Shift+B). It should compile 4 rules with
//    nothing in the Problems tab: one reported rule and one private keyword set
//    for each of the two entrypoints.
// 2. The Scan target is already set to targets/sample.txt in this working copy.
//    Rules > Scan Target (Ctrl+Shift+Enter).
// 3. Two matches, one from each entrypoint: example_office_macro_note and
//    example_shell_script_note.
//
// quipu.toml declares scripts.yar and documents.yar as independent entrypoints,
// in that order. This file is the second of the two, and the one Quipu opens
// first, because the Files view sorts by path while the manifest keeps its own
// order - open View > Includes View to see the difference. Edit anything you
// like: this is your own working copy under Quipu's application data directory,
// and your changes are kept the next time you open the example. See README.md.

include "parts/document_keywords.yar"

rule example_office_macro_note {
    meta:
        author = "Quipu example"
        description = "A document that describes a macro entry point"
    condition:
        example_document_keywords
}
