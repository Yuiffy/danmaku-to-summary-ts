param(
    [string]$Distro = "Ubuntu-22.04",
    [string]$VenvPath = "/opt/asr-vllm",
    [string]$ProjectLinuxPath = "/mnt/d/workspace/myrepo/danmaku-to-summary-ts",
    [switch]$EnableWindowsFeatures,
    [switch]$InstallDistro,
    [switch]$InstallPythonEnv,
    [switch]$WriteConfigSnippet
)

$ErrorActionPreference = "Stop"

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Body
    )
    Write-Host ""
    Write-Host "==> $Name"
    & $Body
}

function Invoke-WslRoot {
    param([string]$Command)
    & wsl.exe -d $Distro -u root -- bash -lc $Command
}

if (-not ($EnableWindowsFeatures -or $InstallDistro -or $InstallPythonEnv -or $WriteConfigSnippet)) {
    $EnableWindowsFeatures = $true
    $InstallDistro = $true
    $InstallPythonEnv = $true
    $WriteConfigSnippet = $true
}

if ($EnableWindowsFeatures) {
    Invoke-Step "Enable Windows WSL features" {
        if (-not (Test-IsAdmin)) {
            throw "This step requires an elevated PowerShell. Re-run PowerShell as Administrator, then run this script with -EnableWindowsFeatures."
        }
        Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -All -NoRestart
        Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All -NoRestart
        Write-Host "Windows features requested. Reboot Windows before continuing with -InstallDistro."
    }
}

if ($InstallDistro) {
    Invoke-Step "Install or register WSL distro $Distro" {
        $registered = (& wsl.exe -l -q) -replace "`0", "" | Where-Object { $_.Trim() -eq $Distro }
        if ($registered) {
            Write-Host "$Distro is already registered."
            return
        }

        if ($Distro -eq "Ubuntu-22.04" -and (Get-Command ubuntu2204.exe -ErrorAction SilentlyContinue)) {
            & ubuntu2204.exe install --root
        } else {
            & wsl.exe --install -d $Distro --no-launch
        }
    }
}

if ($InstallPythonEnv) {
    Invoke-Step "Install Python and CUDA-visible vLLM environment in $Distro" {
        Invoke-WslRoot "set -euo pipefail
            export DEBIAN_FRONTEND=noninteractive
            apt-get update
            apt-get install -y python3 python3-venv python3-pip build-essential git ffmpeg libsndfile1
            python3 -m venv '$VenvPath'
            '$VenvPath/bin/python' -m pip install -U pip setuptools wheel
            '$VenvPath/bin/python' -m pip install 'vllm>=0.12.0' 'funasr>=1.3.7' modelscope soundfile librosa
            '$VenvPath/bin/python' - <<'PY'
import importlib.util
import torch
print('python ok')
print('torch', torch.__version__, 'cuda_available', torch.cuda.is_available())
print('vllm', importlib.util.find_spec('vllm') is not None)
print('funasr', importlib.util.find_spec('funasr') is not None)
PY"
    }
}

if ($WriteConfigSnippet) {
    Invoke-Step "Write project config snippet" {
        $snippet = [ordered]@{
            asr = [ordered]@{
                fun_asr_nano_vllm = [ordered]@{
                    python_executable = "wsl.exe"
                    python_args = @("-d", $Distro, "--", "$VenvPath/bin/python")
                    python_path_map = @(
                        [ordered]@{ from = "D:/"; to = "/mnt/d/" },
                        [ordered]@{ from = "C:/Users/yuiffy"; to = "/mnt/c/Users/yuiffy" }
                    )
                }
            }
        }
        $outDir = Join-Path (Get-Location) "tmp"
        New-Item -ItemType Directory -Force $outDir | Out-Null
        $outFile = Join-Path $outDir "asr-vllm-wsl-config-snippet.json"
        $snippet | ConvertTo-Json -Depth 8 | Set-Content -Path $outFile -Encoding UTF8
        Write-Host "Wrote $outFile"
        Write-Host "After merging the snippet, run:"
        Write-Host "  node src/scripts/asr/asr_vllm_doctor.js --json"
        Write-Host "  npm run asr:vllm-experiment -- --backend fun_asr_nano,fun_asr_nano_vllm --limit 1 --window 20"
    }
}
