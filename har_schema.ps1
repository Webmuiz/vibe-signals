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

$lines = New-Object System.Collections.ArrayList
$files = Get-ChildItem 'har_samples/*.json' | Sort-Object Name
foreach ($f in $files) {
    [void]$lines.Add('')
    [void]$lines.Add('===== ' + $f.Name + ' =====')
    $raw = Get-Content $f.FullName -Raw
    $o = $raw | ConvertFrom-Json
    $inner = $o.respBody
    if ($inner -and $inner.Length -gt 1) {
        try {
            $parsed = $inner | ConvertFrom-Json
            $schema = Get-Schema $parsed '' 0
            foreach ($s in $schema) { [void]$lines.Add($s) }
        }
        catch {
            [void]$lines.Add('NON-JSON body (len=' + $inner.Length + '): ' + $inner.Substring(0, [Math]::Min(300, $inner.Length)))
        }
    }
    else {
        [void]$lines.Add('(empty body)')
    }
}
$lines -join "`n" | Out-File -Encoding utf8 'har_schemas.txt'
Write-Output ('done lines=' + $lines.Count)
