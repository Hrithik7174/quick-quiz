$nodePath = "C:\Users\Hrithik Sadawarte\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (-not (Test-Path $nodePath)) {
  Write-Error "Bundled Node runtime not found at $nodePath"
  exit 1
}

Set-Location $PSScriptRoot
& $nodePath ".\server.js"
