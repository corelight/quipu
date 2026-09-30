// Quipu example: nested includes.
//
// 1. Rules > Compile Workspace (Ctrl+Shift+B). It should compile 4 rules with
//    nothing in the Problems tab. Three of them are private helpers.
// 2. The Scan target is already set to targets/sample.txt in this working copy.
//    Rules > Scan Target (Ctrl+Shift+Enter).
// 3. One match: example_staged_downloader. The private rules it depends on are
//    not reported, which is the point of marking them private.
//
// Open View > Includes View to see the graph this file roots:
//
//     main.yar -> shared/base.yar -> shared/strings/keywords.yar
//
// The first hop is temporarily written relative to the project root so the
// language server can resolve it; the second resolves beside the file that
// asked for it. Edit anything you like - this is your own working copy under
// Quipu's application data directory, and your changes are kept the next time
// you open the example. See README.md.

include "shared/base.yar"

rule example_staged_downloader {
    meta:
        author = "Quipu example"
        description = "A download keyword and a decode keyword in one document"
    condition:
        example_text_body and example_download_keywords and example_decode_keywords
}
