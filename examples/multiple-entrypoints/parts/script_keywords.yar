// Included only by scripts.yar.

private rule example_script_keywords {
    meta:
        description = "Interpreters a dropped script asks to be run by"
    strings:
        $sh = "#!/bin/sh" ascii
        $bash = "#!/bin/bash" ascii
        $ps = "powershell -nop" ascii nocase
    condition:
        any of them
}
