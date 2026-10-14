# Run only on a disposable Windows CI runner: the NSIS check performs a real
# per-user install and uninstall. MSI is inspected through an administrative image.
param([switch] $Offline)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path "$PSScriptRoot/../..").Path
$bundle = Join-Path $repo 'app/src-tauri/target/x86_64-pc-windows-msvc/release/bundle'
$nsis = @(Get-ChildItem "$bundle/nsis/*.exe")
$msi = @(Get-ChildItem "$bundle/msi/*.msi")
if ($nsis.Count -ne 1 -or $msi.Count -ne 1) { throw 'Expected one NSIS and one MSI installer' }
$validation = Join-Path $env:RUNNER_TEMP "quipu-packages-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $validation | Out-Null

function Assert-OfflineRuntime([string] $package) {
    # Hosted runners already have WebView2, so installation alone cannot prove
    # that the standalone runtime is embedded. Inspect the NSIS payload and MSI
    # Binary stream as well (administrative MSI extraction omits that stream).
    $listing = & 7z l -slt $package
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect offline installer: $package" }
    $entries = ($listing -join "`n") -split '\r?\n\r?\n'
    $runtime = @($entries | Where-Object {
        $_ -match '(?m)^Path = .*MicrosoftEdgeWebView2RuntimeInstaller\.exe\r?$'
    })
    if ($runtime.Count -ne 1) { throw "Expected one embedded offline WebView2 installer in $package" }
    $size = [regex]::Match($runtime[0], '(?m)^Size = (\d+)\r?$')
    # The download bootstrapper is only a few MB; the full runtime is much larger.
    if (-not $size.Success -or [long] $size.Groups[1].Value -lt 10MB) {
        throw "Embedded WebView2 payload is too small to be the offline installer: $package"
    }
}

if ($Offline) {
    Assert-OfflineRuntime $nsis[0].FullName
    Assert-OfflineRuntime $msi[0].FullName
}

function Assert-Contents([string] $root) {
    if (-not (Test-Path "$root/quipu.exe" -PathType Leaf)) { throw "Missing executable in $root" }
    $resources = @('LICENSE', 'THIRD_PARTY_LICENSES/NPM.txt', 'THIRD_PARTY_LICENSES/RUST.txt')
    $resources += Get-ChildItem "$repo/examples" -File -Recurse | ForEach-Object {
        [IO.Path]::GetRelativePath($repo, $_.FullName)
    }
    foreach ($relative in $resources) {
        $expected = (Get-FileHash (Join-Path $repo $relative) -Algorithm SHA256).Hash
        $actual = (Get-FileHash (Join-Path $root $relative) -Algorithm SHA256).Hash
        if ($expected -ne $actual) { throw "Packaged resource differs: $relative" }
    }
}

$install = Join-Path $validation 'nsis'
try {
    # NSIS requires /D last and without surrounding quotes, even with spaces.
    $process = Start-Process -FilePath $nsis[0].FullName -ArgumentList "/S /D=$install" -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "NSIS install failed: $($process.ExitCode)" }
    Assert-Contents $install

    $image = Join-Path $validation 'msi'
    $log = Join-Path $validation 'msi.log'
    $process = Start-Process msiexec.exe -ArgumentList "/a `"$($msi[0].FullName)`" /qn TARGETDIR=`"$image`" /l*v `"$log`"" -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        Get-Content $log -Tail 80
        throw "MSI administrative install failed: $($process.ExitCode)"
    }
    $executables = @(Get-ChildItem $image -Filter quipu.exe -Recurse)
    if ($executables.Count -ne 1) { throw 'Expected one executable in MSI image' }
    Assert-Contents $executables[0].DirectoryName
} finally {
    $uninstaller = Join-Path $install 'uninstall.exe'
    if (Test-Path $uninstaller) {
        # _?= runs the uninstaller in place so -Wait observes its completion.
        $process = Start-Process $uninstaller -ArgumentList "/S _?=$install" -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "NSIS uninstall failed: $($process.ExitCode)" }
    }
}
