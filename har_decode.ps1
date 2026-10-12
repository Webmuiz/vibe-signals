$ErrorActionPreference = 'Stop'

function Get-Schema($obj, $prefix, $depth) {
    if ($depth -gt 7) { return }
    if ($null -eq $obj) { Write-Output ($prefix + ' : null'); return }
    if ($obj -is [System.Management.Automation.PSCustomObject]) {
        foreach ($p in $obj.PSObject.Properties) {
            Get-Schema $p.Value ($prefix + '.' + $p.Name) ($depth + 1)
        }
    }
    elseif ($obj -is [System.Array]) {
        Write-Output ($prefix + ' : array[' + $obj.Count + ']')
        if ($obj.Count -gt 0) { Get-Schema $obj[0] ($prefix + '[]') ($depth + 1) }
    }
    else {
        $t = $obj.GetType().Name
        $v = [string]$obj
        if ($v.Length -gt 70) { $v = $v.Substring(0, 70) + '...' }
        Write-Output ($prefix + ' : ' + $t + ' = ' + $v)
    }
}

$targets = @(
    'har_samples/02_GET__api_v1_chains_46630_board.json',
    'har_samples/03_GET__api_v1_chains_46630_v6_launches_cards.json',
    'har_samples/05_GET__api_v1_chains_46630_v6_launches.json',
    'har_samples/06_GET__api_v1_chains_46630_launches.json',
    'har_samples/13_GET__api_v1_chains_46630_v6_wallets__address__launches.json'
)

$lines = New-Object System.Collections.ArrayList
foreach ($t in $targets) {
    [void]$lines.Add('')
    [void]$lines.Add('===== ' + $t + ' =====')
    $o = Get-Content $t -Raw | ConvertFrom-Json
    $b64 = $o.respBody
    $bytes = [System.Convert]::FromBase64String($b64)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    # save decoded
    $outName = 'har_samples/decoded_' + (Split-Path $t -Leaf)
    $text | Out-File -Encoding utf8 $outName
    $parsed = $text | ConvertFrom-Json
    $schema = Get-Schema $parsed '' 0
    foreach ($s in $schema) { [void]$lines.Add($s) }
}
$lines -join "`n" | Out-File -Encoding utf8 'har_schemas_decoded.txt'
Write-Output ('done lines=' + $lines.Count)
