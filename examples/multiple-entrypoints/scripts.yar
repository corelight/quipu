// The first entrypoint declared in quipu.toml. It shares nothing with
// documents.yar: each entrypoint includes only its own keyword set, so no file
// is reached twice and no repeated-inclusion problem is reported.

include "parts/script_keywords.yar"

rule example_shell_script_note {
    meta:
        author = "Quipu example"
        description = "A document that describes a dropped interpreter script"
    condition:
        example_script_keywords
}
