use crate::RagError;
use calamine::{open_workbook_auto, DataType, Reader as _};
use chardetng::EncodingDetector;
use csv as csv_crate;
use html2text;
use infer;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use zip::read::ZipArchive;

/// A page is considered "empty" (likely a scanned image) when its extracted text
/// has fewer than this many non-whitespace characters.
const PDF_EMPTY_PAGE_CHAR_THRESHOLD: usize = 20;
/// Maximum number of empty-page ranges listed in the coverage warning.
const PDF_GAP_MAX_RANGES: usize = 20;
/// How long the external `pdftotext` probe may run before being killed.
const PDFTOTEXT_TIMEOUT_SECS: u64 = 20;

pub fn parse_pdf(file_path: &str) -> Result<String, RagError> {
    let bytes = fs::read(file_path)?;
    // pdf-extract can panic on some malformed PDFs; guard to avoid crashing the app
    let text = match catch_unwind(AssertUnwindSafe(|| {
        pdf_extract::extract_text_from_mem(&bytes)
    })) {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => return Err(RagError::ParseError(format!("PDF parse error: {}", e))),
        Err(payload) => {
            let reason = if let Some(s) = payload.downcast_ref::<&str>() {
                *s
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.as_str()
            } else {
                "unknown parser panic"
            };
            return Err(RagError::ParseError(format!(
                "PDF parsing failed unexpectedly: {}",
                reason
            )));
        }
    };

    // Validate that the PDF has extractable text (not image-based/scanned)
    // Count meaningful characters (excluding whitespace)
    let meaningful_chars = text.chars().filter(|c| !c.is_whitespace()).count();

    // Require at least 50 non-whitespace characters to consider it a text PDF.
    // Only when the in-process extractor comes up nearly empty (a scanned or
    // image-based PDF) do we fork `pdftotext` for per-page coverage — running
    // an external binary on every PDF, including the common fully-text case,
    // would re-read the file for nothing and stall the plugin command path.
    if meaningful_chars < 50 {
        let pdftotext_out = run_pdftotext(file_path);
        let gap_warning = pdftotext_out.as_deref().and_then(|out| {
            let pages = split_pdftotext_pages(out);
            build_pdf_gap_warning(&pages)
        });
        if let Some(fallback) = pdftotext_out {
            let fallback_chars = fallback.chars().filter(|c| !c.is_whitespace()).count();
            if gap_warning.is_some() || fallback_chars >= 50 {
                // pdftotext recovered a text layer (or confirmed the gap);
                // prepend the neutral coverage note plus whatever text exists,
                // rather than dead-ending with an error.
                let body = if fallback_chars > meaningful_chars {
                    fallback
                } else {
                    text
                };
                return Ok(match gap_warning {
                    Some(warning) => format!("{}\n{}", warning, body),
                    None => body,
                });
            }
        }
        return Err(RagError::ParseError(
            "PDF appears to be image-based or scanned; no extractable text layer was found. \
             The pages may be images that require OCR."
                .to_string(),
        ));
    }

    Ok(text)
}

/// Runs `pdftotext <file> -` with a timeout. Returns None when the binary is not on
/// PATH, exits non-zero, or exceeds the timeout — callers treat all of these as
/// "no per-page information available".
fn run_pdftotext(file_path: &str) -> Option<String> {
    let mut child = Command::new("pdftotext")
        .arg(file_path)
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    // Drain stdout on a separate thread so the child never blocks on a full pipe
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + Duration::from_secs(PDFTOTEXT_TIMEOUT_SECS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let buf = reader.join().ok()?;
                if !status.success() {
                    return None;
                }
                return Some(String::from_utf8_lossy(&buf).into_owned());
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Splits `pdftotext` output into per-page text. pdftotext terminates every page
/// (including the last) with a form feed, which leaves one empty trailing segment
/// that is not a real page.
fn split_pdftotext_pages(output: &str) -> Vec<&str> {
    let mut pages: Vec<&str> = output.split('\u{c}').collect();
    if output.ends_with('\u{c}') {
        pages.pop();
    }
    pages
}

/// Builds the scanned-page coverage warning, or None when the document does not
/// have a significant gap. Pure function so the formatting is unit-testable.
///
/// The message is deliberately neutral: `parse_document` is shared with the
/// RAG embedding and inline-chat attachment paths, so it must not leak
/// agent-only tool names or the document's absolute filesystem path into a
/// user's chat context or vector store.
fn build_pdf_gap_warning(pages: &[&str]) -> Option<String> {
    if pages.is_empty() {
        return None;
    }
    let counts: Vec<usize> = pages
        .iter()
        .map(|p| p.chars().filter(|c| !c.is_whitespace()).count())
        .collect();
    let empty_total = counts
        .iter()
        .filter(|&&c| c < PDF_EMPTY_PAGE_CHAR_THRESHOLD)
        .count();
    // Only warn when the gap is significant: at least 2 empty pages AND
    // (at least 20% of all pages, or at least 10 pages in absolute terms)
    if empty_total < 2 || (empty_total * 5 < pages.len() && empty_total < 10) {
        return None;
    }

    let ranges = empty_page_ranges(&counts, PDF_EMPTY_PAGE_CHAR_THRESHOLD);
    let mut warning = format!(
        "[WARNING: incomplete text extraction] {} of {} pages contain no extractable text (likely scanned images).\n",
        empty_total,
        pages.len()
    );
    warning.push_str("Empty page ranges:\n");
    for &(start, end) in ranges.iter().take(PDF_GAP_MAX_RANGES) {
        let label = if start == end {
            format!("page {}", start)
        } else {
            format!("pages {}-{}", start, end)
        };
        match last_text_before(pages, start) {
            Some((page_no, snippet)) => warning.push_str(&format!(
                "  - {} (last text before gap, page {}: \"{}\")\n",
                label, page_no, snippet
            )),
            None => warning.push_str(&format!("  - {} (no text extracted before this gap)\n", label)),
        }
    }
    if ranges.len() > PDF_GAP_MAX_RANGES {
        warning.push_str(&format!(
            "  - ... and {} more empty ranges\n",
            ranges.len() - PDF_GAP_MAX_RANGES
        ));
    }
    warning.push_str(
        "These pages have no text layer and are omitted below; they may be scanned images that require OCR.\n",
    );
    Some(warning)
}

/// Groups pages whose char count is below `threshold` into 1-based inclusive ranges.
fn empty_page_ranges(counts: &[usize], threshold: usize) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start: Option<usize> = None;
    for (i, &count) in counts.iter().enumerate() {
        if count < threshold {
            if start.is_none() {
                start = Some(i + 1);
            }
        } else if let Some(s) = start.take() {
            ranges.push((s, i));
        }
    }
    if let Some(s) = start {
        ranges.push((s, counts.len()));
    }
    ranges
}

/// Finds the nearest page before a gap that has real text, returning its 1-based
/// page number and a trailing snippet of its content.
fn last_text_before(pages: &[&str], range_start_1based: usize) -> Option<(usize, String)> {
    let mut i = range_start_1based.saturating_sub(1);
    while i >= 1 {
        let page = pages[i - 1];
        if page.chars().filter(|c| !c.is_whitespace()).count() >= PDF_EMPTY_PAGE_CHAR_THRESHOLD {
            return Some((i, tail_snippet(page, 90)));
        }
        i -= 1;
    }
    None
}

/// Collapses whitespace and keeps at most the last `max_chars` characters.
fn tail_snippet(text: &str, max_chars: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let total = collapsed.chars().count();
    if total <= max_chars {
        collapsed
    } else {
        let tail: String = collapsed.chars().skip(total - max_chars).collect();
        format!("...{}", tail)
    }
}

pub fn parse_text(file_path: &str) -> Result<String, RagError> {
    read_text_auto(file_path)
}

pub fn parse_document(file_path: &str, file_type: &str) -> Result<String, RagError> {
    match file_type.to_lowercase().as_str() {
        "pdf" | "application/pdf" => parse_pdf(file_path),
        "txt" | "text/plain" | "md" | "text/markdown"
        // JavaScript / TypeScript
        | "js" | "mjs" | "cjs" | "ts" | "mts" | "cts" | "jsx" | "tsx"
        // Python
        | "py" | "pyw" | "pyi"
        // C / C++
        | "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx"
        // Systems languages
        | "rs" | "go" | "swift" | "zig"
        // JVM languages
        | "java" | "kt" | "kts" | "scala" | "groovy"
        // Scripting languages
        | "rb" | "php" | "lua" | "pl" | "pm" | "r" | "jl"
        // .NET
        | "cs" | "fs" | "vb"
        // Shell
        | "sh" | "bash" | "zsh" | "fish" | "ps1" | "psm1"
        // Web
        | "css" | "scss" | "sass" | "less" | "vue" | "svelte" | "astro"
        // Data / config formats
        | "json" | "jsonc" | "yaml" | "yml" | "toml" | "xml" | "ini"
        | "cfg" | "conf" | "config" | "env" | "properties"
        // Query / markup
        | "sql" | "graphql" | "gql" | "tex" | "rst" | "adoc"
        // Misc text
        | "log" | "diff" | "patch" | "gitignore" | "dockerfile" | "makefile" => parse_text(file_path),
        "csv" | "text/csv" => parse_csv(file_path),
        // Excel family via calamine
        "xlsx"
        | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        | "xls"
        | "application/vnd.ms-excel"
        | "ods"
        | "application/vnd.oasis.opendocument.spreadsheet" => parse_spreadsheet(file_path),
        // PowerPoint
        "pptx"
        | "application/vnd.openxmlformats-officedocument.presentationml.presentation" => parse_pptx(file_path),
        // HTML
        "html" | "htm" | "text/html" => parse_html(file_path),
        "docx"
        | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
            parse_docx(file_path)
        }
        other => {
            // Try MIME sniffing when extension or MIME is unknown
            match infer::get_from_path(file_path) {
                Ok(Some(k)) => {
                    let mime = k.mime_type();
                    // Guard against infinite recursion if mime matches the unknown extension
                    if mime != other {
                        return parse_document(file_path, mime);
                    }
                    Err(RagError::UnsupportedFileType(other.to_string()))
                }
                _ => {
                    // infer returned None → no binary magic bytes detected, treat as plain text
                    parse_text(file_path)
                }
            }
        }
    }
}

fn parse_docx(file_path: &str) -> Result<String, RagError> {
    let file = std::fs::File::open(file_path)?;
    let mut zip = ZipArchive::new(file).map_err(|e| RagError::ParseError(e.to_string()))?;

    // Standard DOCX stores document text at word/document.xml
    let mut doc_xml = match zip.by_name("word/document.xml") {
        Ok(f) => f,
        Err(_) => return Err(RagError::ParseError("document.xml not found".into())),
    };
    let mut xml_content = String::new();
    doc_xml
        .read_to_string(&mut xml_content)
        .map_err(|e| RagError::ParseError(e.to_string()))?;

    // Parse XML and extract text from w:t nodes; add newlines on w:p boundaries.
    // Tables (w:tbl/w:tr/w:tc) are emitted as one line per row with tab-separated
    // cells, and w:br produces a newline.
    let mut reader = Reader::from_str(&xml_content);
    reader.trim_text(true);
    let mut buf = Vec::new();
    let mut result = String::new();
    let mut in_text = false;
    let mut table_depth: usize = 0;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name: String = reader
                    .decoder()
                    .decode(e.name().as_ref())
                    .unwrap_or(Cow::Borrowed(""))
                    .into_owned();
                if name.ends_with(":t") || name == "w:t" || name == "t" {
                    in_text = true;
                }
                if name.ends_with(":tbl") || name == "tbl" {
                    table_depth += 1;
                }
            }
            Ok(Event::Empty(e)) => {
                let name: String = reader
                    .decoder()
                    .decode(e.name().as_ref())
                    .unwrap_or(Cow::Borrowed(""))
                    .into_owned();
                if name.ends_with(":br") || name == "br" {
                    // Explicit line break; inside a table cell keep the row on one line
                    if table_depth == 0 {
                        result.push('\n');
                    } else {
                        result.push(' ');
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name: String = reader
                    .decoder()
                    .decode(e.name().as_ref())
                    .unwrap_or(Cow::Borrowed(""))
                    .into_owned();
                if name.ends_with(":t") || name == "w:t" || name == "t" {
                    in_text = false;
                    result.push(' ');
                } else if name.ends_with(":tc") || name == "tc" {
                    // Cell end – tab-separate cells within a row
                    while result.ends_with(' ') {
                        result.pop();
                    }
                    result.push('\t');
                } else if name.ends_with(":tr") || name == "tr" {
                    // Row end – one line per table row
                    while result.ends_with('\t') || result.ends_with(' ') {
                        result.pop();
                    }
                    result.push('\n');
                } else if name.ends_with(":tbl") || name == "tbl" {
                    table_depth = table_depth.saturating_sub(1);
                    result.push('\n');
                } else if name.ends_with(":p") || name == "w:p" || name == "p" {
                    // Paragraph end – add newline; inside a table cell, keep the row
                    // on one line and just space-separate the paragraphs
                    if table_depth == 0 {
                        result.push_str("\n\n");
                    } else {
                        result.push(' ');
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if in_text {
                    let text = t.unescape().unwrap_or_default();
                    result.push_str(&text);
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(RagError::ParseError(e.to_string())),
            _ => {}
        }
    }

    // Normalize whitespace (trim line ends only, so table rows whose leading cells
    // are empty keep their tab separators)
    let normalized = result
        .lines()
        .map(|l| l.trim_end())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(normalized)
}

fn parse_csv(file_path: &str) -> Result<String, RagError> {
    let mut rdr = csv_crate::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_path(file_path)
        .map_err(|e| RagError::ParseError(e.to_string()))?;
    let mut out = String::new();
    for rec in rdr.records() {
        let rec = rec.map_err(|e| RagError::ParseError(e.to_string()))?;
        out.push_str(&rec.iter().collect::<Vec<_>>().join(", "));
        out.push('\n');
    }
    Ok(out)
}

fn parse_spreadsheet(file_path: &str) -> Result<String, RagError> {
    let mut workbook =
        open_workbook_auto(file_path).map_err(|e| RagError::ParseError(e.to_string()))?;
    // Best-effort: cell fill colors are only recoverable from real .xlsx archives.
    // .xls/.ods (and any hiccup in the color pass) silently skip it.
    let fill_colors = extract_xlsx_fill_colors(file_path).unwrap_or_default();
    let mut out = String::new();
    for sheet_name in workbook.sheet_names().to_owned() {
        if let Ok(range) = workbook.worksheet_range(&sheet_name) {
            out.push_str(&format!("# Sheet: {}\n", sheet_name));
            for row in range.rows() {
                let cells = row
                    .iter()
                    .map(|c| match c {
                        DataType::Empty => "".to_string(),
                        DataType::String(s) => s.to_string(),
                        DataType::Float(f) => format!("{}", f),
                        DataType::Int(i) => i.to_string(),
                        DataType::Bool(b) => b.to_string(),
                        DataType::DateTime(f) => format!("{}", f),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join("\t");
                out.push_str(&cells);
                out.push('\n');
            }
            out.push_str("\n");
            if let Some(cells) = fill_colors.get(&sheet_name) {
                out.push_str(&format!("# Fill colors (non-default) — Sheet: {}\n", sheet_name));
                for (cell_ref, color) in cells {
                    out.push_str(&format!("{}={}\n", cell_ref, color));
                }
                out.push_str("\n");
            }
        }
    }
    Ok(out)
}

/// Legacy indexed-color palette (ECMA-376 §18.8.27). Indices 64/65 are
/// system-dependent and intentionally absent.
const XLSX_INDEXED_COLORS: [&str; 64] = [
    "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
    "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
    "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
    "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
    "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF",
    "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
    "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696",
    "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
];

#[derive(Default)]
struct XlsxStyles {
    /// Fill index -> fill color ("AARRGGBB", or "theme:N" best-effort)
    fills: Vec<Option<String>>,
    /// cellXfs xf index -> fillId
    xf_fill_ids: Vec<usize>,
}

/// Best-effort extraction of non-default cell fill colors from a real .xlsx
/// archive: sheet name -> [(cell reference, color)] in document order. Returns
/// None whenever anything is missing or unparseable (.xls, .ods, no styles, ...),
/// which callers treat as "no color information".
fn extract_xlsx_fill_colors(file_path: &str) -> Option<HashMap<String, Vec<(String, String)>>> {
    let file = std::fs::File::open(file_path).ok()?;
    let mut zip = ZipArchive::new(file).ok()?;

    let styles_xml = read_zip_entry(&mut zip, "xl/styles.xml")?;
    let styles = parse_xlsx_styles(&styles_xml);
    if styles.fills.iter().all(|f| f.is_none()) {
        return None;
    }

    let workbook_xml = read_zip_entry(&mut zip, "xl/workbook.xml")?;
    let rels_xml = read_zip_entry(&mut zip, "xl/_rels/workbook.xml.rels")?;

    let mut result: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for (sheet_name, sheet_path) in parse_xlsx_sheet_paths(&workbook_xml, &rels_xml) {
        let Some(sheet_xml) = read_zip_entry(&mut zip, &sheet_path) else {
            continue;
        };
        let cells = collect_styled_cells(&sheet_xml, &styles);
        if !cells.is_empty() {
            result.insert(sheet_name, cells);
        }
    }
    if result.is_empty() {
        None
    } else {
        Some(result)
    }
}

fn read_zip_entry(zip: &mut ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut entry = zip.by_name(name).ok()?;
    let mut content = String::new();
    entry.read_to_string(&mut content).ok()?;
    Some(content)
}

/// Returns the value of the attribute with the given local name (namespace
/// prefixes such as `r:` are ignored).
fn xml_attr(e: &BytesStart, name: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| a.key.local_name().as_ref() == name)
        .map(|a| {
            let raw = String::from_utf8_lossy(&a.value).into_owned();
            match quick_xml::escape::unescape(&raw) {
                Ok(unescaped) => unescaped.into_owned(),
                Err(_) => raw,
            }
        })
}

/// Resolves a patternFill fgColor to a display value: `rgb` as-is (uppercased),
/// `indexed` via the legacy palette, `theme` reported as "theme:N" best-effort.
fn fg_color_value(e: &BytesStart) -> Option<String> {
    if let Some(rgb) = xml_attr(e, b"rgb") {
        return Some(rgb.to_ascii_uppercase());
    }
    if let Some(index) = xml_attr(e, b"indexed").and_then(|v| v.parse::<usize>().ok()) {
        return XLSX_INDEXED_COLORS.get(index).map(|hex| format!("FF{}", hex));
    }
    if let Some(theme) = xml_attr(e, b"theme") {
        // Resolving theme colors needs xl/theme/theme1.xml; report the slot instead
        return Some(format!("theme:{}", theme));
    }
    None
}

/// Streams xl/styles.xml collecting the fills list and the cellXfs xf -> fillId map.
fn parse_xlsx_styles(xml: &str) -> XlsxStyles {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    let mut buf = Vec::new();
    let mut styles = XlsxStyles::default();
    let mut in_fills = false;
    let mut in_cell_xfs = false;
    let mut pattern_active = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e)) => match e.name().local_name().as_ref() {
                b"fills" => in_fills = true,
                b"cellXfs" => in_cell_xfs = true,
                b"fill" if in_fills => {
                    styles.fills.push(None);
                    pattern_active = false;
                }
                b"patternFill" if in_fills => {
                    // patternType defaults to "none" when absent
                    pattern_active = xml_attr(&e, b"patternType")
                        .map(|t| t != "none")
                        .unwrap_or(false);
                }
                b"fgColor" if in_fills && pattern_active => {
                    if let Some(slot) = styles.fills.last_mut() {
                        if slot.is_none() {
                            *slot = fg_color_value(&e);
                        }
                    }
                }
                b"xf" if in_cell_xfs => {
                    let fill_id = xml_attr(&e, b"fillId")
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or(0);
                    styles.xf_fill_ids.push(fill_id);
                }
                _ => {}
            },
            Ok(Event::End(e)) => match e.name().local_name().as_ref() {
                b"fills" => in_fills = false,
                b"cellXfs" => in_cell_xfs = false,
                b"fill" | b"patternFill" => pattern_active = false,
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    styles
}

/// Maps sheet names to their worksheet XML paths inside the archive via
/// xl/workbook.xml and xl/_rels/workbook.xml.rels, preserving workbook order.
fn parse_xlsx_sheet_paths(workbook_xml: &str, rels_xml: &str) -> Vec<(String, String)> {
    let mut rel_targets: HashMap<String, String> = HashMap::new();
    let mut reader = Reader::from_str(rels_xml);
    reader.trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e)) => {
                if e.name().local_name().as_ref() == b"Relationship" {
                    if let (Some(id), Some(target)) = (xml_attr(&e, b"Id"), xml_attr(&e, b"Target"))
                    {
                        rel_targets.insert(id, target);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    let mut sheets = Vec::new();
    let mut reader = Reader::from_str(workbook_xml);
    reader.trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e)) => {
                if e.name().local_name().as_ref() == b"sheet" {
                    // `r:id` has local name `id`; `sheetId` does not collide with it
                    if let (Some(name), Some(rel_id)) = (xml_attr(&e, b"name"), xml_attr(&e, b"id"))
                    {
                        if let Some(target) = rel_targets.get(&rel_id) {
                            // Targets are relative to xl/ unless they start with "/"
                            let path = match target.strip_prefix('/') {
                                Some(absolute) => absolute.to_string(),
                                None => format!("xl/{}", target),
                            };
                            sheets.push((name, path));
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    sheets
}

/// Streams a worksheet XML for `<c r="A1" s="3">` cells whose style resolves to a
/// non-default fill (fillId 0 is "no fill" and fillId 1 is the gray125 default).
fn collect_styled_cells(sheet_xml: &str, styles: &XlsxStyles) -> Vec<(String, String)> {
    let mut cells = Vec::new();
    let mut reader = Reader::from_str(sheet_xml);
    reader.trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e) | Event::Empty(e)) => {
                if e.name().local_name().as_ref() == b"c" {
                    let style_index = xml_attr(&e, b"s").and_then(|v| v.parse::<usize>().ok());
                    if let (Some(cell_ref), Some(style_index)) = (xml_attr(&e, b"r"), style_index) {
                        if let Some(&fill_id) = styles.xf_fill_ids.get(style_index) {
                            if fill_id >= 2 {
                                if let Some(Some(color)) = styles.fills.get(fill_id) {
                                    cells.push((cell_ref, color.clone()));
                                }
                            }
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    cells
}

fn parse_pptx(file_path: &str) -> Result<String, RagError> {
    let file = std::fs::File::open(file_path)?;
    let mut zip = ZipArchive::new(file).map_err(|e| RagError::ParseError(e.to_string()))?;

    // Collect slide files (ppt/slides/slideN.xml) keyed by their numeric index so
    // that slide10.xml sorts after slide2.xml (a lexical sort would interleave them)
    let mut slides: Vec<(usize, String)> = Vec::new();
    for i in 0..zip.len() {
        let name = zip
            .by_index(i)
            .map(|f| f.name().to_string())
            .unwrap_or_default();
        if let Some(index) = pptx_slide_index(&name) {
            slides.push((index, name));
        }
    }
    slides.sort();

    let mut output = String::new();
    for (index, slide_name) in slides {
        let xml = {
            let mut file = zip
                .by_name(&slide_name)
                .map_err(|e| RagError::ParseError(e.to_string()))?;
            let mut xml = String::new();
            file.read_to_string(&mut xml)
                .map_err(|e| RagError::ParseError(e.to_string()))?;
            xml
        };
        output.push_str(&format!("## Slide {}\n", index));
        let text = extract_pptx_text(&xml);
        let text = text.trim();
        if !text.is_empty() {
            output.push_str(text);
            output.push('\n');
        }
        // Speaker notes live at ppt/notesSlides/notesSlideN.xml. Mapping notesSlideN
        // to slideN by name convention is an approximation (the authoritative mapping
        // is in each slide's relationships), but holds for PowerPoint-produced files.
        if let Some(notes_xml) =
            read_zip_entry(&mut zip, &format!("ppt/notesSlides/notesSlide{}.xml", index))
        {
            let notes = extract_pptx_text(&notes_xml);
            let notes = notes.trim();
            if !notes.is_empty() {
                output.push_str("Notes: ");
                output.push_str(notes);
                output.push('\n');
            }
        }
        output.push('\n');
    }
    Ok(output)
}

/// Returns the numeric index of a ppt/slides/slideN.xml archive entry, or None for
/// anything else (rels, notes, non-slide files).
fn pptx_slide_index(zip_entry_name: &str) -> Option<usize> {
    zip_entry_name
        .strip_prefix("ppt/slides/slide")?
        .strip_suffix(".xml")?
        .parse()
        .ok()
}

fn extract_pptx_text(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    let mut buf = Vec::new();
    let mut result = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name: String = reader
                    .decoder()
                    .decode(e.name().as_ref())
                    .unwrap_or(Cow::Borrowed(""))
                    .into_owned();
                if name.ends_with(":t") || name == "a:t" || name == "t" {
                    in_text = true;
                }
            }
            Ok(Event::End(e)) => {
                let name: String = reader
                    .decoder()
                    .decode(e.name().as_ref())
                    .unwrap_or(Cow::Borrowed(""))
                    .into_owned();
                if name.ends_with(":t") || name == "a:t" || name == "t" {
                    in_text = false;
                    result.push(' ');
                }
            }
            Ok(Event::Text(t)) => {
                if in_text {
                    let text = t.unescape().unwrap_or_default();
                    result.push_str(&text);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    result
}

fn parse_html(file_path: &str) -> Result<String, RagError> {
    let html = read_text_auto(file_path)?;
    // 80-column wrap default
    Ok(html2text::from_read(Cursor::new(html), 80))
}

fn read_text_auto(file_path: &str) -> Result<String, RagError> {
    let bytes = fs::read(file_path)?;
    // Detect encoding
    let mut detector = EncodingDetector::new();
    detector.feed(&bytes, true);
    let enc = detector.guess(None, true);
    let (decoded, _, had_errors) = enc.decode(&bytes);
    if had_errors {
        // fallback to UTF-8 lossy
        Ok(String::from_utf8_lossy(&bytes).to_string())
    } else {
        Ok(decoded.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use zip::write::FileOptions;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("tauri-plugin-rag-tests");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(format!("{}-{}", std::process::id(), name))
    }

    fn write_zip_fixture(path: &Path, entries: &[(&str, &str)]) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for (name, content) in entries {
            zip.start_file(*name, FileOptions::default()).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    // ---- XLSX fill colors ----

    const XLSX_CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>"#;

    const XLSX_ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#;

    const XLSX_WORKBOOK: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#;

    const XLSX_WORKBOOK_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#;

    const XLSX_SHEET1: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1"><v>42</v></c></row>
<row r="2"><c r="B2" s="1"><v>7</v></c></row>
</sheetData>
</worksheet>"#;

    const XLSX_STYLES_COLORED: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF478A7"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/>
</cellXfs>
</styleSheet>"#;

    const XLSX_STYLES_PLAIN: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fills count="2">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
</fills>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
</cellXfs>
</styleSheet>"#;

    fn xlsx_entries(styles: &'static str) -> Vec<(&'static str, &'static str)> {
        vec![
            ("[Content_Types].xml", XLSX_CONTENT_TYPES),
            ("_rels/.rels", XLSX_ROOT_RELS),
            ("xl/workbook.xml", XLSX_WORKBOOK),
            ("xl/_rels/workbook.xml.rels", XLSX_WORKBOOK_RELS),
            ("xl/styles.xml", styles),
            ("xl/worksheets/sheet1.xml", XLSX_SHEET1),
        ]
    }

    #[test]
    fn test_parse_spreadsheet_xlsx_fill_colors() {
        let plain_path = temp_path("plain.xlsx");
        write_zip_fixture(&plain_path, &xlsx_entries(XLSX_STYLES_PLAIN));
        let colored_path = temp_path("colored.xlsx");
        write_zip_fixture(&colored_path, &xlsx_entries(XLSX_STYLES_COLORED));

        let plain = parse_spreadsheet(plain_path.to_str().unwrap()).unwrap();
        let colored = parse_spreadsheet(colored_path.to_str().unwrap()).unwrap();

        assert!(plain.starts_with("# Sheet: Sheet1\n"), "values missing: {:?}", plain);
        assert!(plain.contains("42"), "values missing: {:?}", plain);
        assert!(!plain.contains("# Fill colors"), "unexpected color section: {:?}", plain);
        // The values pass must stay byte-identical; the color section is additive
        assert_eq!(
            colored,
            format!(
                "{}# Fill colors (non-default) — Sheet: Sheet1\nB2=FFF478A7\n\n",
                plain
            )
        );

        let _ = std::fs::remove_file(&plain_path);
        let _ = std::fs::remove_file(&colored_path);
    }

    #[test]
    fn test_parse_xlsx_styles_rgb_indexed_theme() {
        let xml = r#"<styleSheet>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="fff478a7"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor indexed="2"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor theme="4"/></patternFill></fill>
</fills>
<cellXfs count="2"><xf fillId="0"/><xf fillId="2"/></cellXfs>
</styleSheet>"#;
        let styles = parse_xlsx_styles(xml);
        assert_eq!(styles.fills.len(), 5);
        assert_eq!(styles.fills[0], None);
        assert_eq!(styles.fills[1], None);
        assert_eq!(styles.fills[2].as_deref(), Some("FFF478A7"));
        assert_eq!(styles.fills[3].as_deref(), Some("FFFF0000"));
        assert_eq!(styles.fills[4].as_deref(), Some("theme:4"));
        assert_eq!(styles.xf_fill_ids, vec![0, 2]);
    }

    // ---- PPTX ----

    #[test]
    fn test_parse_pptx_slide_order_and_notes() {
        let path = temp_path("deck.pptx");
        write_zip_fixture(
            &path,
            &[
                ("ppt/slides/slide10.xml", r#"<sld><a:t>Kappa</a:t></sld>"#),
                ("ppt/slides/slide1.xml", r#"<sld><a:t>Alpha</a:t></sld>"#),
                ("ppt/slides/slide2.xml", r#"<sld><a:t>Beta</a:t></sld>"#),
                ("ppt/slides/_rels/slide1.xml.rels", r#"<Relationships/>"#),
                (
                    "ppt/notesSlides/notesSlide2.xml",
                    r#"<sld><a:t>speaker note two</a:t></sld>"#,
                ),
            ],
        );
        let out = parse_pptx(path.to_str().unwrap()).unwrap();

        let s1 = out.find("## Slide 1\n").unwrap();
        let s2 = out.find("## Slide 2\n").unwrap();
        let s10 = out.find("## Slide 10\n").unwrap();
        assert!(s1 < s2 && s2 < s10, "slides out of order: {:?}", out);
        assert!(out.contains("Alpha") && out.contains("Beta") && out.contains("Kappa"));
        // Notes attach to their own slide (between the Slide 2 and Slide 10 headers)
        let notes = out.find("Notes: speaker note two").unwrap();
        assert!(s2 < notes && notes < s10, "notes misplaced: {:?}", out);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_pptx_slide_index() {
        assert_eq!(pptx_slide_index("ppt/slides/slide12.xml"), Some(12));
        assert_eq!(pptx_slide_index("ppt/slides/slide1.xml"), Some(1));
        assert_eq!(pptx_slide_index("ppt/slides/_rels/slide1.xml.rels"), None);
        assert_eq!(pptx_slide_index("ppt/notesSlides/notesSlide1.xml"), None);
        assert_eq!(pptx_slide_index("ppt/slides/slideLayout1.xml"), None);
    }

    // ---- DOCX ----

    #[test]
    fn test_parse_docx_tables_and_breaks() {
        let path = temp_path("doc.docx");
        let document = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Intro</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>Line1</w:t><w:br/><w:t>Line2</w:t></w:r></w:p>
</w:body></w:document>"#;
        write_zip_fixture(&path, &[("word/document.xml", document)]);

        let out = parse_docx(path.to_str().unwrap()).unwrap();
        assert_eq!(out, "Intro\nA\tB\nC\tD\nLine1\nLine2");

        let _ = std::fs::remove_file(&path);
    }

    // ---- PDF coverage gap-map ----

    fn pages_from_counts(counts: &[usize]) -> Vec<String> {
        counts.iter().map(|&c| "x".repeat(c)).collect()
    }

    #[test]
    fn test_empty_page_ranges() {
        assert_eq!(
            empty_page_ranges(&[100, 0, 0, 0, 100, 5], 20),
            vec![(2, 4), (6, 6)]
        );
        assert_eq!(empty_page_ranges(&[0, 0], 20), vec![(1, 2)]);
        assert_eq!(empty_page_ranges(&[100, 100], 20), Vec::<(usize, usize)>::new());
        assert_eq!(empty_page_ranges(&[], 20), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn test_gap_warning_triggered_and_formatted() {
        let mut counts = vec![100usize; 10];
        for count in counts.iter_mut().take(6).skip(2) {
            *count = 0; // pages 3-6 (1-based) are empty
        }
        let pages = pages_from_counts(&counts);
        let refs: Vec<&str> = pages.iter().map(String::as_str).collect();
        let warning = build_pdf_gap_warning(&refs).unwrap();
        assert!(warning.contains("4 of 10 pages"), "{}", warning);
        assert!(warning.contains("pages 3-6"), "{}", warning);
        assert!(warning.contains("page 2"), "{}", warning);
        // Neutral message: no agent tool names, no absolute path leak.
        assert!(warning.contains("scanned images"), "{}", warning);
        assert!(!warning.contains("pdftoppm"), "{}", warning);
        assert!(!warning.contains("/tmp/scan.pdf"), "{}", warning);
        assert!(!warning.contains("vision.describe"), "{}", warning);
        assert!(!warning.contains("ocrmypdf"), "{}", warning);
    }

    #[test]
    fn test_gap_warning_context_snippet() {
        let pages = vec![
            "Chapter one discusses the quarterly results".to_string(),
            String::new(),
            String::new(),
            "closing remarks and appendix material follow".to_string(),
            String::new(),
            String::new(),
        ];
        let refs: Vec<&str> = pages.iter().map(String::as_str).collect();
        let warning = build_pdf_gap_warning(&refs).unwrap();
        assert!(warning.contains("pages 2-3"), "{}", warning);
        assert!(warning.contains("quarterly results"), "{}", warning);
        assert!(warning.contains("pages 5-6"), "{}", warning);
        assert!(warning.contains("appendix"), "{}", warning);
    }

    #[test]
    fn test_gap_warning_not_triggered_single_page() {
        // One scanned page is below the 2-page minimum
        assert!(build_pdf_gap_warning(&[""]).is_none());
        assert!(build_pdf_gap_warning(&[]).is_none());
    }

    #[test]
    fn test_gap_warning_not_triggered_small_fraction() {
        // 2 empty of 20 pages: under 20% and under 10 absolute
        let mut counts = vec![100usize; 20];
        counts[3] = 0;
        counts[10] = 0;
        let pages = pages_from_counts(&counts);
        let refs: Vec<&str> = pages.iter().map(String::as_str).collect();
        assert!(build_pdf_gap_warning(&refs).is_none());
    }

    #[test]
    fn test_gap_warning_absolute_threshold() {
        // 10 empty of 100 pages: only 10% but at least 10 pages absolute
        let mut counts = vec![100usize; 100];
        for count in counts.iter_mut().take(50).skip(40) {
            *count = 0; // pages 41-50
        }
        let pages = pages_from_counts(&counts);
        let refs: Vec<&str> = pages.iter().map(String::as_str).collect();
        let warning = build_pdf_gap_warning(&refs).unwrap();
        assert!(warning.contains("10 of 100 pages"), "{}", warning);
        assert!(warning.contains("pages 41-50"), "{}", warning);
    }

    #[test]
    fn test_gap_warning_range_cap() {
        // Alternating text/empty: 45 separate single-page gaps
        let mut counts = Vec::new();
        for _ in 0..45 {
            counts.push(100);
            counts.push(0);
        }
        let pages = pages_from_counts(&counts);
        let refs: Vec<&str> = pages.iter().map(String::as_str).collect();
        let warning = build_pdf_gap_warning(&refs).unwrap();
        assert_eq!(warning.matches("last text before gap").count(), 20);
        assert!(warning.contains("and 25 more empty ranges"), "{}", warning);
    }

    #[test]
    fn test_split_pdftotext_pages() {
        assert_eq!(split_pdftotext_pages("one\u{c}two\u{c}"), vec!["one", "two"]);
        // An empty final page is kept — only the terminator segment is dropped
        assert_eq!(split_pdftotext_pages("one\u{c}\u{c}"), vec!["one", ""]);
        assert_eq!(split_pdftotext_pages("no-terminator"), vec!["no-terminator"]);
    }

    #[test]
    fn test_tail_snippet() {
        assert_eq!(tail_snippet("short  text\nhere", 90), "short text here");
        let long = "word ".repeat(50);
        let snippet = tail_snippet(&long, 20);
        assert!(snippet.starts_with("..."), "{}", snippet);
        assert_eq!(snippet.chars().count(), 23);
    }

    #[test]
    #[ignore = "requires the `pdftotext` binary on PATH"]
    fn test_run_pdftotext_live() {
        // A minimal single-page PDF with no text content; poppler reconstructs the
        // missing xref table on its own
        let pdf = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n";
        let path = temp_path("empty.pdf");
        std::fs::write(&path, pdf).unwrap();
        let out = run_pdftotext(path.to_str().unwrap())
            .expect("pdftotext should handle a minimal PDF");
        assert_eq!(split_pdftotext_pages(&out).len(), 1);
        let _ = std::fs::remove_file(&path);
    }
}
