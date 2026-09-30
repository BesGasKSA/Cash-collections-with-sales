# Opens workbooks the app exported (saved by the mock server's POST /__save into
# .superpowers/exports) in real Microsoft Excel. ExcelJS and SheetJS read files
# Excel refuses, so only Excel can say a file really opens. Needs Excel
# installed; Excel is driven in this process (a background job cannot drive it
# and hangs). -Pdf also prints each file to a PDF beside it, to look at the
# pages; it can take minutes on the area template's list sheets. Usage:
#   powershell -ExecutionPolicy Bypass -File tests/export-opens-in-excel.ps1 [-Only name.xlsx] [-Pdf]
param([string]$Only = '', [switch]$Pdf)
$dir = (Resolve-Path (Join-Path $PSScriptRoot "..\.superpowers\exports")).Path
$files = @(Get-ChildItem $dir -Filter *.xlsx | Where-Object { $_.Name -notlike 'v_*' -and (!$Only -or $_.Name -eq $Only) })
$x = New-Object -ComObject Excel.Application
$x.DisplayAlerts = $false
$bad = 0
foreach ($f in $files) {
  try {
    $wb = $x.Workbooks.Open($f.FullName, 0, $true)
    if ($Pdf) { $wb.ExportAsFixedFormat(0, [IO.Path]::ChangeExtension($f.FullName, '.pdf')) }
    $wb.Close($false)
    "opens  $($f.Name)"
  } catch { $bad++; "FAILS  $($f.Name)" }
}
$x.Quit()
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($x)
if ($bad) { "$bad file(s) Excel refuses"; exit 1 } else { "checked $($files.Count) file(s): all open in Excel" }
