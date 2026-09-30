// Quipu example: basic text match.
//
// 1. Rules > Compile Workspace (Ctrl+Shift+B). It should compile 2 rules with
//    nothing in the Problems tab.
// 2. The Scan target is already set to targets/sample.txt in this working copy.
//    Rules > Scan Target (Ctrl+Shift+Enter).
// 3. Both example_encoded_command and example_suspicious_url match. Use
//    "Choose file..." to swap in targets/clean.txt and scan again for none.
//
// This project has no quipu.toml, so Quipu infers the entrypoint: this is the
// only rule file and nothing includes it. Edit it freely - this is your own
// working copy under Quipu's application data directory, and your changes are
// kept the next time you open the example. See README.md beside this file.

rule example_encoded_command {
    meta:
        author = "Quipu example"
        description = "Text describing a base64 blob piped into a shell"
    strings:
        $decode = "base64 -d" ascii
        $shell = "| sh" ascii
    condition:
        all of them
}

rule example_suspicious_url {
    meta:
        author = "Quipu example"
        description = "Text describing a quiet download over plain HTTP"
    strings:
        $scheme = "http://" ascii
        $tool = "curl -s" ascii
    condition:
        all of them
}
