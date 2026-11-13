param(
    [Parameter(Mandatory = $true)]
    [string]$EpubPath
)

$ErrorActionPreference = 'Stop'
$resolvedPath = (Resolve-Path -LiteralPath $EpubPath).Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($resolvedPath)

try {
    $entryMap = @{}
    foreach ($entry in $archive.Entries) {
        $entryMap[$entry.FullName] = $entry
    }

    $texts = @{}
    $xmlParseErrors = @()
    $replacementCharacters = 0
    $xmlFiles = @($archive.Entries | Where-Object { $_.FullName -match '\.(xhtml|html|xml|opf|ncx)$' })

    foreach ($entry in $xmlFiles) {
        $reader = [System.IO.StreamReader]::new($entry.Open(), [System.Text.Encoding]::UTF8, $true)
        try {
            $content = $reader.ReadToEnd()
            $texts[$entry.FullName] = $content
            $replacementCharacters += ([regex]::Matches($content, [char]0xFFFD)).Count
            try { [void][xml]$content } catch { $xmlParseErrors += $entry.FullName }
        }
        finally {
            $reader.Dispose()
        }
    }

    $brokenLinks = @()
    $localLinkCount = 0
    $footnoteLinkCount = 0

    foreach ($sourceName in @($texts.Keys | Where-Object { $_ -match '\.(xhtml|html)$' })) {
        foreach ($match in [regex]::Matches($texts[$sourceName], 'href=["'']([^"'']+)["'']')) {
            $href = [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
            if ($href -match '^(https?:|mailto:|tel:)') { continue }
            $localLinkCount++
            if ($href -match 'fn(ref)?-') { $footnoteLinkCount++ }

            $hashIndex = $href.IndexOf('#')
            if ($hashIndex -ge 0) {
                $pathPart = $href.Substring(0, $hashIndex)
                $fragment = [Uri]::UnescapeDataString($href.Substring($hashIndex + 1))
            }
            else {
                $pathPart = $href
                $fragment = ''
            }

            if ([string]::IsNullOrEmpty($pathPart)) {
                $targetName = $sourceName
            }
            else {
                $baseUri = [Uri]("https://epub.local/" + $sourceName)
                $targetName = [Uri]::UnescapeDataString(([Uri]::new($baseUri, $pathPart)).AbsolutePath.TrimStart('/'))
            }

            if (-not $entryMap.ContainsKey($targetName)) {
                $brokenLinks += "$sourceName -> $href (missing file $targetName)"
                continue
            }

            if (-not [string]::IsNullOrEmpty($fragment) -and $texts.ContainsKey($targetName)) {
                $escaped = [regex]::Escape($fragment)
                if ($texts[$targetName] -notmatch ('\bid=["'']' + $escaped + '["'']')) {
                    $brokenLinks += "$sourceName -> $href (missing anchor $fragment)"
                }
            }
        }
    }

    $result = [ordered]@{
        file = $resolvedPath
        bytes = (Get-Item -LiteralPath $resolvedPath).Length
        archive_entries = $archive.Entries.Count
        xhtml_files = @($archive.Entries | Where-Object { $_.FullName -match '\.(xhtml|html)$' }).Count
        has_mimetype = $entryMap.ContainsKey('mimetype')
        has_container = $entryMap.ContainsKey('META-INF/container.xml')
        has_navigation = @($archive.Entries | Where-Object { $_.FullName -match '(nav\.xhtml|toc\.ncx)$' }).Count -gt 0
        xml_parse_errors = $xmlParseErrors
        replacement_characters = $replacementCharacters
        local_links_checked = $localLinkCount
        footnote_links_checked = $footnoteLinkCount
        broken_links = $brokenLinks
    }

    $result | ConvertTo-Json -Depth 5

    if (-not $result.has_mimetype -or -not $result.has_container -or -not $result.has_navigation -or
        $result.xml_parse_errors.Count -gt 0 -or $result.replacement_characters -gt 0 -or
        $result.broken_links.Count -gt 0) {
        exit 1
    }
}
finally {
    $archive.Dispose()
}
