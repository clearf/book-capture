# Windows OCR CLI — the Windows counterpart of vision-ocr.swift.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File win-ocr.ps1 <image_path> [--lang ja,en]
# Output: JSON { "text": "...", "confidence": null, "blocks": [...], "pageCount": 1, "language": "en-US" }
#
# Uses Windows.Media.Ocr (built into Windows 10/11, no install). It reports no
# confidence score, so "confidence" is null here and book-capture-utils.mjs
# estimates one from the text. Blocks are OCR lines in the engine's reading order
# (it already handles multi-column layouts), with boundingBox [x, y, w, h]
# normalized to 0..1 and a top-left origin.
param([Parameter(Position = 0)][string]$ImagePath, [Parameter(ValueFromRemainingArguments)][string[]]$Rest)
$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
  [Console]::Error.Write((@{ error = $msg } | ConvertTo-Json -Compress))
  exit 1
}

if (-not $ImagePath) { Fail 'Usage: win-ocr.ps1 <image_path> [--lang ja,en]' }
$languages = @('ja', 'en')
if ($Rest) {
  $langIdx = [array]::IndexOf([string[]]$Rest, '--lang')
  if ($langIdx -ge 0 -and $langIdx + 1 -lt $Rest.Count) { $languages = $Rest[$langIdx + 1].Split(',') }
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }

  # Windows OCR runs one language per engine: take the first requested language
  # that has an installed recognizer, else fall back to the user's profile languages.
  $engine = $null
  foreach ($tag in $languages) {
    $match = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages |
      Where-Object { $_.LanguageTag -eq $tag -or $_.LanguageTag -like "$tag-*" } | Select-Object -First 1
    if ($match) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($match); break }
  }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { Fail 'No Windows OCR language is installed (Settings > Time & language > Language).' }

  $fullPath = [System.IO.Path]::GetFullPath($ImagePath)
  if (-not (Test-Path -LiteralPath $fullPath)) { Fail "Image not found: $fullPath" }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  } finally { $stream.Dispose() }

  $w = [double]$bitmap.PixelWidth; $h = [double]$bitmap.PixelHeight
  $blocks = @(foreach ($line in $result.Lines) {
    $rects = $line.Words | ForEach-Object { $_.BoundingRect }
    $x0 = ($rects | Measure-Object X -Minimum).Minimum
    $y0 = ($rects | Measure-Object Y -Minimum).Minimum
    $x1 = ($rects | ForEach-Object { $_.X + $_.Width } | Measure-Object -Maximum).Maximum
    $y1 = ($rects | ForEach-Object { $_.Y + $_.Height } | Measure-Object -Maximum).Maximum
    [ordered]@{ text = $line.Text; boundingBox = @(($x0 / $w), ($y0 / $h), (($x1 - $x0) / $w), (($y1 - $y0) / $h)) }
  })

  $out = [ordered]@{
    text = (($blocks | ForEach-Object { $_.text }) -join "`n")
    confidence = $null
    blocks = $blocks
    pageCount = 1
    language = $engine.RecognizerLanguage.LanguageTag
  }
  # Force UTF-8 so curly quotes and accents survive the pipe to Node.
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::Out.Write(($out | ConvertTo-Json -Depth 5 -Compress))
} catch {
  Fail $_.Exception.Message
}
