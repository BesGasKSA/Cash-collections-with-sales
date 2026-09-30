# Opens every workbook the app exported (saved by the mock server's /__save into
# .superpowers/exports) in real Microsoft Excel, and prints each as a PDF next to
# it. ExcelJS and SheetJS read files Excel refuses, so only Excel can say a file
# really opens. Each file gets its own Excel, 60 seconds at most; only Excel
# processes this script started are ever stopped (a workbook the user has open
# is left alone). Needs Excel installed. Usage:
#   powershell -ExecutionPolicy Bypass -File tests/export-opens-in-excel.ps1
$dir = (Resolve-Path (Join-Path $PSScriptRoot "..\.superpowers\exports")).Path
$bad = 0
Get-ChildItem $dir -Filter *.xlsx | Where-Object { $_.Name -notlike 'v_*' } | ForEach-Object {
  $n = $_.Name; $full = $_.FullName
  $before = @(Get-Process EXCEL -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $job = Start-Job -ArgumentList $full -ScriptBlock {
    param($f)
    $x = New-Object -ComObject Excel.Application
    $x.DisplayAlerts = $false; $x.AskToUpdateLinks = $false
    try {
      $wb = $x.Workbooks.Open($f, 0, $true)
      $wb.ExportAsFixedFormat(0, [IO.Path]::ChangeExtension($f, '.pdf'))
      $wb.Close($false); 'opens'
    } catch { 'fails' } finally { $x.Quit() }
  }
  $done = Wait-Job $job -Timeout 60
  $res = if ($done) { Receive-Job $job } else { 'hangs' }
  Remove-Job $job -Force
  Get-Process EXCEL -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($res -ne 'opens') { $bad++ }
  "{0,-6} {1}" -f $res, $n
}
if ($bad) { "$bad file(s) Excel refuses or hangs on"; exit 1 } else { "every export opens in Excel" }
