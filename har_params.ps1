$ErrorActionPreference = 'Stop'
$entries = Get-Content 'har_entries.json' -Raw | ConvertFrom-Json

$lines = New-Object System.Collections.ArrayList
$groups = $entries | Group-Object key | Sort-Object Name
foreach ($g in $groups) {
    [void]$lines.Add('')
    [void]$lines.Add('===== ' + $g.Name + ' =====')
    # unique query strings
    $qs = @()
    foreach ($e in $g.Group) {
        $u = [System.Uri]::new($e.url)
        if ($u.Query) { $qs += $u.Query }
    }
    $uniqQs = $qs | Sort-Object -Unique
    [void]$lines.Add('QUERY STRINGS (' + $uniqQs.Count + ' unique):')
    foreach ($q in $uniqQs) { [void]$lines.Add('  ' + $q) }
    # headers from first entry
    $first = $g.Group[0]
    [void]$lines.Add('REQUEST HEADERS:')
    foreach ($h in ($first.reqHeaders -split "`n")) { [void]$lines.Add('  ' + $h) }
    # request body if any
    if ($first.reqBody -and $first.reqBody.Length -gt 1) {
        [void]$lines.Add('REQUEST BODY: ' + $first.reqBody.Substring(0, [Math]::Min(400, $first.reqBody.Length)))
    }
    # statuses
    $st = ($g.Group | ForEach-Object { $_.status } | Sort-Object -Unique) -join ','
    [void]$lines.Add('STATUSES: ' + $st)
}
$lines -join "`n" | Out-File -Encoding utf8 'har_params.txt'
Write-Output ('done lines=' + $lines.Count)
