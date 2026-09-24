# Generate tabBar icons as PNG.
#
# Why this exists: WeChat mini program tabBar icons only accept png/jpg/jpeg,
# never svg. The icons are redrawn here with GDI+ (the OS's canonical PNG
# encoder) from the original 24-unit design coordinates, with antialiasing.
# Rationale for GDI+: a hand-rolled PNG encoder produced files that other
# decoders accepted but WeChat would not render.
#
# NOTE: comments in this file are intentionally ASCII-only. Windows PowerShell
# 5.1 reads BOM-less scripts using the system ANSI codepage, so non-ASCII
# comment bytes can be mis-decoded and break parsing.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/gen-tabbar-icons.ps1
#
# Colors match tabBar color / selectedColor in src/app.config.ts.

Add-Type -AssemblyName System.Drawing

$OutDir = Join-Path $PSScriptRoot '..\src\assets\tabbar'
$Size = 81
$Scale = $Size / 24.0

$NormalColor = [System.Drawing.Color]::FromArgb(255, 0x6f, 0x7c, 0x8b)
$SelectedColor = [System.Drawing.Color]::FromArgb(255, 0x13, 0x22, 0x39)

# design coordinate (24 units) -> pixels
function P([double]$v) { return [single]($v * $Scale) }

function New-Pen([System.Drawing.Color]$color, [double]$width) {
  $pen = New-Object System.Drawing.Pen($color, (P $width))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  return $pen
}

function Add-Line($g, $pen, [double]$x1, [double]$y1, [double]$x2, [double]$y2) {
  $g.DrawLine($pen, (P $x1), (P $y1), (P $x2), (P $y2))
}

function Add-RoundRect($g, $pen, [double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $d = 2 * $r
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc((P $x), (P $y), (P $d), (P $d), 180, 90)
  $path.AddArc((P ($x + $w - $d)), (P $y), (P $d), (P $d), 270, 90)
  $path.AddArc((P ($x + $w - $d)), (P ($y + $h - $d)), (P $d), (P $d), 0, 90)
  $path.AddArc((P $x), (P ($y + $h - $d)), (P $d), (P $d), 90, 90)
  $path.CloseFigure()
  $g.DrawPath($pen, $path)
  $path.Dispose()
}

function Add-Ellipse($g, $pen, [double]$cx, [double]$cy, [double]$r) {
  $g.DrawEllipse($pen, (P ($cx - $r)), (P ($cy - $r)), (P (2 * $r)), (P (2 * $r)))
}

function Add-FillEllipse($g, $brush, [double]$cx, [double]$cy, [double]$r) {
  $g.FillEllipse($brush, (P ($cx - $r)), (P ($cy - $r)), (P (2 * $r)), (P (2 * $r)))
}

function Add-Check($g, $pen) {
  $points = @(
    (New-Object System.Drawing.PointF((P 8.5), (P 15))),
    (New-Object System.Drawing.PointF((P 10.7), (P 17.2))),
    (New-Object System.Drawing.PointF((P 15), (P 12.8)))
  )
  $g.DrawLines($pen, $points)
}

# chat bubble: ring plus a short tail on the lower-left
function Draw-Chat($g, $color, [double]$w) {
  $pen = New-Pen $color $w
  Add-Ellipse $g $pen 12 11.5 8.5
  Add-Line $g $pen 5.9 16.8 4.1 19.2
  $pen.Dispose()
}

# calendar: frame, two hangers, divider, check mark
function Draw-Calendar($g, $color, [double]$w) {
  $pen = New-Pen $color $w
  Add-RoundRect $g $pen 3 4 18 17 3
  Add-Line $g $pen 8 2 8 6
  Add-Line $g $pen 16 2 16 6
  Add-Line $g $pen 3 9.5 21 9.5
  Add-Check $g $pen
  $pen.Dispose()
}

function New-Icon([string]$file, [System.Drawing.Color]$color, [scriptblock]$draw) {
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  & $draw $g $color

  $path = Join-Path $OutDir $file
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()

  # read back with the same decoder, so a broken file cannot pass silently
  $check = [System.Drawing.Image]::FromFile($path)
  Write-Host ("{0}  {1}x{2}  {3} bytes" -f $file, $check.Width, $check.Height, (Get-Item $path).Length)
  $check.Dispose()
}

New-Icon 'chat.png' $NormalColor { param($g, $color) Draw-Chat $g $color 1.5 }
New-Icon 'chat-selected.png' $SelectedColor {
  param($g, $color)
  Draw-Chat $g $color 2
  $pen = New-Pen $color 2
  Add-Line $g $pen 8 10.5 16 10.5
  Add-Line $g $pen 8 14 13 14
  $pen.Dispose()
}

New-Icon 'plan.png' $NormalColor { param($g, $color) Draw-Calendar $g $color 1.5 }
New-Icon 'plan-selected.png' $SelectedColor { param($g, $color) Draw-Calendar $g $color 2 }

New-Icon 'mine.png' $NormalColor {
  param($g, $color)
  $pen = New-Pen $color 1.5
  Add-Ellipse $g $pen 12 7.5 4.5
  $g.DrawArc($pen, (P 4.5), (P 13), (P 15), (P 15), 180, 180)
  $pen.Dispose()
}

New-Icon 'mine-selected.png' $SelectedColor {
  param($g, $color)
  # selected state fills the head so it reads differently at a glance
  $brush = New-Object System.Drawing.SolidBrush($color)
  Add-FillEllipse $g $brush 12 7.5 4.5
  $brush.Dispose()
  $pen = New-Pen $color 2
  $g.DrawArc($pen, (P 4.5), (P 13), (P 15), (P 15), 180, 180)
  $pen.Dispose()
}

Write-Host ''
Write-Host "generated 6 icons into $OutDir"
