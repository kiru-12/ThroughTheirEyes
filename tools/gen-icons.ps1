Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$iconDir = Join-Path $root 'icons'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

function New-EyeIcon {
  param([int]$Size, [string]$Path, [double]$Scale = 0.82)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  $g.Clear([System.Drawing.Color]::FromArgb(255, 13, 13, 13))

  $cx = $Size / 2.0
  $cy = $Size / 2.0
  $R  = ($Size / 2.0) * $Scale * 0.74

  # Eye almond (white)
  $eyePath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $eyePath.AddBezier(
    [single]($cx - $R), [single]$cy,
    [single]($cx - $R * 0.4), [single]($cy - $R * 0.64),
    [single]($cx + $R * 0.4), [single]($cy - $R * 0.64),
    [single]($cx + $R), [single]$cy)
  $eyePath.AddBezier(
    [single]($cx + $R), [single]$cy,
    [single]($cx + $R * 0.4), [single]($cy + $R * 0.64),
    [single]($cx - $R * 0.4), [single]($cy + $R * 0.64),
    [single]($cx - $R), [single]$cy)
  $eyePath.CloseFigure()

  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 240, 240, 240))
  $g.FillPath($white, $eyePath)

  $penW = [Math]::Max(2.0, $Size * 0.02)
  $pen  = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 79, 158, 255)), ([single]$penW)
  $g.DrawPath($pen, $eyePath)

  # Iris (radial blue gradient)
  $irisR = $R * 0.52
  $irisRect = New-Object System.Drawing.RectangleF([single]($cx - $irisR), [single]($cy - $irisR), [single]($irisR * 2), [single]($irisR * 2))
  $irisPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $irisPath.AddEllipse($irisRect)
  $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($irisPath)
  $pgb.CenterColor = [System.Drawing.Color]::FromArgb(255, 122, 184, 255)
  $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 31, 92, 192))
  $g.FillEllipse($pgb, $irisRect)

  # Pupil
  $pupR = $R * 0.22
  $pupRect = New-Object System.Drawing.RectangleF([single]($cx - $pupR), [single]($cy - $pupR), [single]($pupR * 2), [single]($pupR * 2))
  $pupil = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 8, 14, 26))
  $g.FillEllipse($pupil, $pupRect)

  # Highlight
  $hlR = $R * 0.09
  $hlRect = New-Object System.Drawing.RectangleF([single]($cx - $irisR * 0.35 - $hlR), [single]($cy - $irisR * 0.35 - $hlR), [single]($hlR * 2), [single]($hlR * 2))
  $hl = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 255, 255, 255))
  $g.FillEllipse($hl, $hlRect)

  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output ("wrote " + $Path)
}

New-EyeIcon -Size 192 -Path (Join-Path $iconDir 'icon-192.png') -Scale 0.82
New-EyeIcon -Size 512 -Path (Join-Path $iconDir 'icon-512.png') -Scale 0.82
New-EyeIcon -Size 180 -Path (Join-Path $iconDir 'apple-touch-icon.png') -Scale 0.82
New-EyeIcon -Size 512 -Path (Join-Path $iconDir 'icon-maskable-512.png') -Scale 0.60
