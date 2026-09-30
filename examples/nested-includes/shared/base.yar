// Level one of the include graph. main.yar currently names this file relative
// to the project root, and this file reaches the leaf beside itself.

include "strings/keywords.yar"

private rule example_text_body {
    meta:
        description = "A body long enough to be worth reading the keywords of"
    condition:
        filesize > 64
}
