// Level two of the include graph, and its leaf: two private keyword sets that
// shared/base.yar pulls in and main.yar's rule refers to by name.

private rule example_download_keywords {
    meta:
        description = "Ways of fetching a file quietly"
    strings:
        $curl = "curl -s" ascii
        $wget = "wget -q" ascii
        $ps = "Invoke-WebRequest" ascii nocase
    condition:
        any of them
}

private rule example_decode_keywords {
    meta:
        description = "Ways of turning text back into bytes"
    strings:
        $shell = "base64 -d" ascii
        $dotnet = "FromBase64String" ascii nocase
        $certutil = "certutil -decode" ascii nocase
    condition:
        any of them
}
