# 生成横版高分辨率测试图（3840x2160 PNG，含渐变与几何图形）
Add-Type -AssemblyName System.Drawing
$w = 3840; $h = 2160
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($w, $h)),
  [System.Drawing.Color]::FromArgb(255, 30, 60, 120),
  [System.Drawing.Color]::FromArgb(255, 180, 60, 30))
$g.FillRectangle($grad, 0, 0, $w, $h)

$yellow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 220, 0))
$g.FillEllipse($yellow, 400, 400, 900, 900)

$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 240, 240, 240))
$g.FillRectangle($white, 2200, 700, 1100, 900)

$green = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 40, 200, 120))
$g.FillEllipse($green, 2600, 200, 500, 400)

$g.Dispose()
$outDir = Join-Path $PSScriptRoot ""
$outFile = Join-Path $outDir "test-landscape.png"
$bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved: $outFile"
