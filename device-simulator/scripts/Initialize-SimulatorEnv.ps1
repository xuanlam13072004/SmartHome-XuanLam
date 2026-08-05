[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$moduleRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $moduleRoot
$templatePath = Join-Path $moduleRoot 'docker.env.example'
$outputPath = Join-Path $moduleRoot '.env.docker'
$apiGatewayEnvPath = Join-Path $workspaceRoot 'api-gateway\.env.docker'

if (-not (Test-Path -LiteralPath $templatePath)) {
    throw "Missing simulator environment template: $templatePath"
}

if (-not (Test-Path -LiteralPath $apiGatewayEnvPath)) {
    throw "Missing API Gateway Docker environment: $apiGatewayEnvPath"
}

if ((Test-Path -LiteralPath $outputPath) -and -not $Force) {
    Write-Host 'Simulator environment already exists. Use -Force to regenerate it.'
    exit 0
}

function Read-EnvFile {
    param([Parameter(Mandatory)][string]$Path)

    $result = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match '^\s*#' -or $line -notmatch '=') {
            continue
        }

        $parts = $line -split '=', 2
        $result[$parts[0].Trim()] = $parts[1]
    }
    return $result
}

function New-HexSecret {
    param([int]$ByteLength = 32)

    $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes($ByteLength)
    return [System.Convert]::ToHexString($bytes).ToLowerInvariant()
}

$upstream = Read-EnvFile -Path $apiGatewayEnvPath
$requiredUpstreamKeys = @(
    'PG_USER',
    'PG_PASSWORD',
    'PG_DATABASE',
    'MONGO_URI',
    'MONGO_DB_NAME',
    'MONGO_DEVICE_SHADOWS_COLLECTION',
    'MONGO_TELEMETRY_COLLECTION'
)

foreach ($key in $requiredUpstreamKeys) {
    if (-not $upstream.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($upstream[$key])) {
        throw "API Gateway environment is missing required key: $key"
    }
}

$overrides = @{
    ADMIN_TOKEN                      = New-HexSecret
    CREDENTIAL_ENCRYPTION_KEY        = New-HexSecret
    POSTGRES_USER                    = $upstream['PG_USER']
    POSTGRES_PASSWORD                = $upstream['PG_PASSWORD']
    POSTGRES_DB                      = $upstream['PG_DATABASE']
    MAIN_MONGODB_URI                 = $upstream['MONGO_URI']
    MAIN_MONGO_DB_NAME               = $upstream['MONGO_DB_NAME']
    MAIN_MONGO_DEVICE_SHADOWS_COLLECTION = $upstream['MONGO_DEVICE_SHADOWS_COLLECTION']
    MAIN_MONGO_TELEMETRY_COLLECTION      = $upstream['MONGO_TELEMETRY_COLLECTION']
}

$outputLines = foreach ($line in [System.IO.File]::ReadAllLines($templatePath)) {
    if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=') {
        $key = $Matches[1]
        if ($overrides.ContainsKey($key)) {
            "$key=$($overrides[$key])"
            continue
        }
    }
    $line
}

[System.IO.File]::WriteAllLines(
    $outputPath,
    $outputLines,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host 'Created device-simulator/.env.docker with generated local secrets.'
Write-Host 'PostgreSQL and main MongoDB settings were synchronized from api-gateway/.env.docker.'
