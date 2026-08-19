# DSH 热插拔中枢 - 生成说明文档 (TXT + DOCX)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$contentPath = Join-Path $root 'dev-doc-content.md'
$txtPath = Join-Path $root 'DSH-Hotplug-Hub-开发文档.txt'
$docxPath = Join-Path $root 'DSH-Hotplug-Hub-开发文档.docx'

$content = [System.IO.File]::ReadAllText($contentPath, [System.Text.Encoding]::UTF8)

function ConvertTo-Txt {
    param([string]$Text)
    $lines = $Text -split "`r?`n"
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        if ($line -match '^\|.*\|\s*$') {
            $cells = $line.Trim('|').Split('|') | ForEach-Object { $_.Trim() }
            if ($cells -join '' -match '^:?-{2,}:?$') { continue }
            $out.Add(($cells -join ' | '))
            continue
        }
        if ($line -match '^```') { continue }
        if ($line -match '^### ') { $out.Add(''); $out.Add(($line -replace '^### ', '')); $out.Add(''); continue }
        if ($line -match '^## ') { $out.Add(''); $out.Add(('== ' + ($line -replace '^## ', '') + ' ==')); $out.Add(''); continue }
        if ($line -match '^# ') { $out.Add(''); $out.Add(('# ' + ($line -replace '^# ', '') + ' #')); $out.Add(''); continue }
        if ($line.Trim() -eq '') { $out.Add(''); continue }
        $out.Add($line)
    }
    return $out.ToArray()
}

function Get-XmlEscaped {
    param([string]$s)
    if ($null -eq $s) { return '' }
    return $s.Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;').Replace('"','&quot;').Replace("'",'&apos;')
}

function Add-DocxParagraph {
    param($xml, [string]$text, [string]$style = 'Normal', [bool]$mono = $false)
    $rpr = ''
    if ($mono) { $rpr = '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/><w:sz w:val="18"/></w:rPr>' }
    $pPr = ''
    if ($style -ne 'Normal') { $pPr = "<w:pPr><w:pStyle w:val='$style'/></w:pPr>" }
    $xml.Append("<w:p>$pPr<w:r>$rpr<w:t xml:space='preserve'>$(Get-XmlEscaped $text)</w:t></w:r></w:p>") | Out-Null
}

function Add-DocxTable {
    param($xml, [string[]]$header, [string[][]]$rows)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/></w:tblBorders></w:tblPr>')
    if ($header) {
        [void]$sb.Append('<w:tr>')
        foreach ($h in $header) { [void]$sb.Append("<w:tc><w:tcPr><w:shd w:val='clear' w:fill='E8F0EC'/></w:tcPr><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space='preserve'>$(Get-XmlEscaped $h)</w:t></w:r></w:p></w:tc>") }
        [void]$sb.Append('</w:tr>')
    }
    foreach ($row in $rows) {
        [void]$sb.Append('<w:tr>')
        foreach ($cell in $row) { [void]$sb.Append("<w:tc><w:p><w:r><w:t xml:space='preserve'>$(Get-XmlEscaped $cell)</w:t></w:r></w:p></w:tc>") }
        [void]$sb.Append('</w:tr>')
    }
    [void]$sb.Append('</w:tbl>')
    $xml.Append($sb.ToString()) | Out-Null
    $xml.Append('<w:p/>') | Out-Null
}

function ConvertTo-DocxXml {
    param([string]$Text)
    $lines = $Text -split "`r?`n"
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>')
    $i = 0
    $inCode = $false
    while ($i -lt $lines.Count) {
        $line = $lines[$i]
        if ($line -match '^```') {
            $inCode = -not $inCode
            $i++
            continue
        }
        if ($inCode) {
            Add-DocxParagraph $sb $line 'Normal' $true
            $i++
            continue
        }
        if ($line -match '^\|.*\|\s*$') {
            $tableLines = @()
            while ($i -lt $lines.Count -and $lines[$i] -match '^\|.*\|\s*$') {
                $tableLines += $lines[$i]
                $i++
            }
            $parsed = @()
            foreach ($tl in $tableLines) {
                $cells = $tl.Trim('|').Split('|') | ForEach-Object { $_.Trim() }
                if ($cells -join '' -match '^:?-{2,}:?$') { continue }
                $parsed += ,$cells
            }
            if ($parsed.Count -gt 0) {
                $header = $parsed[0]
                $rows = @()
                for ($r = 1; $r -lt $parsed.Count; $r++) { $rows += ,$parsed[$r] }
                Add-DocxTable $sb $header $rows
            }
            continue
        }
        if ($line -match '^### ') {
            Add-DocxParagraph $sb ($line -replace '^### ', '') 'Heading3'
            $i++
            continue
        }
        if ($line -match '^## ') {
            Add-DocxParagraph $sb ($line -replace '^## ', '') 'Heading2'
            $i++
            continue
        }
        if ($line -match '^# ') {
            Add-DocxParagraph $sb ($line -replace '^# ', '') 'Heading1'
            $i++
            continue
        }
        if ($line -match '^\s*-\s+') {
            $text = $line -replace '^\s*-\s+', ''
            Add-DocxParagraph $sb ('• ' + $text)
            $i++
            continue
        }
        if ($line -match '^\d+\.\s+') {
            $text = $line -replace '^\d+\.\s+', ''
            Add-DocxParagraph $sb ($text)
            $i++
            continue
        }
        if ($line.Trim() -ne '') {
            Add-DocxParagraph $sb $line
        }
        $i++
    }
    [void]$sb.Append('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>')
    return $sb.ToString()
}

function New-Docx {
    param([string]$Path, [string]$DocumentXml)
    $contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'
    $rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'
    $docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>'
    $styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="0E7C6B"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="0F2F2A"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="17201D"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/></w:tblBorders></w:tblPr></w:style></w:styles>'
    $settings = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/></w:settings>'
    $core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>DSH 热插拔中枢说明</dc:title><dc:creator>dsh-hotplug-hub</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-08-19T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-08-19T00:00:00Z</dcterms:modified></cp:coreProperties>'
    $app = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>DSH Hotplug Hub Documentation</Application></Properties>'

    if (Test-Path $Path) { Remove-Item $Path -Force }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create)
    $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        function Add-ZipEntry($zip, $name, $text) {
            $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
            $sw = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding($false)))
            try { $sw.Write($text) } finally { $sw.Dispose() }
        }
        Add-ZipEntry $zip '[Content_Types].xml' $contentTypes
        Add-ZipEntry $zip '_rels/.rels' $rels
        Add-ZipEntry $zip 'word/document.xml' $DocumentXml
        Add-ZipEntry $zip 'word/_rels/document.xml.rels' $docRels
        Add-ZipEntry $zip 'word/styles.xml' $styles
        Add-ZipEntry $zip 'word/settings.xml' $settings
        Add-ZipEntry $zip 'docProps/core.xml' $core
        Add-ZipEntry $zip 'docProps/app.xml' $app
    } finally {
        $zip.Dispose()
        $fs.Dispose()
    }
}

# 生成 TXT
$txtLines = ConvertTo-Txt -Text $content
[System.IO.File]::WriteAllLines($txtPath, $txtLines, (New-Object System.Text.UTF8Encoding($true)))

# 生成 DOCX
$docXml = ConvertTo-DocxXml -Text $content
New-Docx -Path $docxPath -DocumentXml $docXml

Write-Output "TXT : $txtPath"
Write-Output "DOCX: $docxPath"