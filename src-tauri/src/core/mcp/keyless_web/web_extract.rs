#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExtractMode {
    Markdown,
    Text,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ExtractedWebContent {
    pub text: String,
    pub title: Option<String>,
    pub extractor: &'static str,
}

pub(super) fn extract_web_content(
    body: &str,
    content_type: &str,
    mode: ExtractMode,
) -> ExtractedWebContent {
    let content_type = content_type.to_ascii_lowercase();
    if content_type.contains("text/markdown") {
        return ExtractedWebContent {
            text: body.trim().to_owned(),
            title: None,
            extractor: "markdown",
        };
    }
    if !content_type.contains("html") && !looks_like_html(body) {
        return ExtractedWebContent {
            text: body.trim().to_owned(),
            title: None,
            extractor: "plain",
        };
    }

    let title = extract_element(body, "title")
        .map(|value| html_fragment_to_text(value, ExtractMode::Text))
        .filter(|value| !value.is_empty());
    let (fragment, extractor) = extract_element(body, "article")
        .map(|value| (value, "article"))
        .or_else(|| extract_element(body, "main").map(|value| (value, "main")))
        .or_else(|| extract_element(body, "body").map(|value| (value, "body")))
        .unwrap_or((body, "document"));
    let cleaned = remove_non_content_blocks(fragment);

    ExtractedWebContent {
        text: html_fragment_to_text(&cleaned, mode),
        title,
        extractor,
    }
}

pub(super) fn html_fragment_to_text(fragment: &str, mode: ExtractMode) -> String {
    let mut output = String::with_capacity(fragment.len());
    let mut cursor = 0;
    while cursor < fragment.len() {
        let Some(relative_open) = fragment[cursor..].find('<') else {
            output.push_str(&decode_entities(&fragment[cursor..]));
            break;
        };
        let open = cursor + relative_open;
        output.push_str(&decode_entities(&fragment[cursor..open]));
        let Some(relative_close) = fragment[open..].find('>') else {
            output.push_str(&decode_entities(&fragment[open..]));
            break;
        };
        let close = open + relative_close;
        append_tag_separator(&mut output, &fragment[open + 1..close], mode);
        cursor = close + 1;
    }
    normalize_whitespace(&output, mode)
}

fn append_tag_separator(output: &mut String, raw_tag: &str, mode: ExtractMode) {
    let tag = raw_tag.trim();
    if tag.starts_with('!') || tag.starts_with('?') {
        return;
    }
    let closing = tag.starts_with('/');
    let name = tag
        .trim_start_matches('/')
        .split_ascii_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches('/')
        .to_ascii_lowercase();

    match name.as_str() {
        "br" | "p" | "div" | "section" | "article" | "main" | "tr" => output.push('\n'),
        "li" if !closing && mode == ExtractMode::Markdown => output.push_str("\n- "),
        "li" => output.push('\n'),
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" if !closing => {
            output.push('\n');
            if mode == ExtractMode::Markdown {
                let level = name[1..].parse::<usize>().unwrap_or(1);
                output.push_str(&"#".repeat(level));
                output.push(' ');
            }
        }
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => output.push('\n'),
        _ => {}
    }
}

fn remove_non_content_blocks(fragment: &str) -> String {
    [
        "script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form",
    ]
    .iter()
    .fold(fragment.to_owned(), |content, tag| {
        remove_elements(&content, tag)
    })
}

fn remove_elements(html: &str, tag: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut cursor = 0;
    let open_pattern = format!("<{tag}");
    let close_pattern = format!("</{tag}>");
    while let Some(open) = find_ascii_case_insensitive(html, &open_pattern, cursor) {
        output.push_str(&html[cursor..open]);
        let Some(open_end_relative) = html[open..].find('>') else {
            cursor = html.len();
            break;
        };
        let content_start = open + open_end_relative + 1;
        let Some(close) = find_ascii_case_insensitive(html, &close_pattern, content_start) else {
            cursor = content_start;
            continue;
        };
        cursor = close + close_pattern.len();
    }
    output.push_str(&html[cursor..]);
    output
}

fn extract_element<'a>(html: &'a str, tag: &str) -> Option<&'a str> {
    let open_pattern = format!("<{tag}");
    let open = find_ascii_case_insensitive(html, &open_pattern, 0)?;
    let boundary = html.as_bytes().get(open + open_pattern.len()).copied()?;
    if !boundary.is_ascii_whitespace() && boundary != b'>' {
        return None;
    }
    let open_end = open + html[open..].find('>')?;
    let close_pattern = format!("</{tag}>");
    let close = find_ascii_case_insensitive(html, &close_pattern, open_end + 1)?;
    Some(&html[open_end + 1..close])
}

fn looks_like_html(body: &str) -> bool {
    ["<!doctype html", "<html", "<body", "<article", "<main"]
        .iter()
        .any(|marker| find_ascii_case_insensitive(body, marker, 0).is_some())
}

fn find_ascii_case_insensitive(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    if from > haystack.len() {
        return None;
    }
    let needle = needle.as_bytes();
    haystack.as_bytes()[from..]
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
        .map(|position| from + position)
}

fn decode_entities(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    while let Some(relative_amp) = input[cursor..].find('&') {
        let amp = cursor + relative_amp;
        output.push_str(&input[cursor..amp]);
        let Some(relative_semicolon) = input[amp..].find(';') else {
            output.push_str(&input[amp..]);
            return output;
        };
        let semicolon = amp + relative_semicolon;
        let entity = &input[amp + 1..semicolon];
        if let Some(decoded) = decode_entity(entity) {
            output.push(decoded);
            cursor = semicolon + 1;
        } else {
            output.push('&');
            cursor = amp + 1;
        }
    }
    output.push_str(&input[cursor..]);
    output
}

fn decode_entity(entity: &str) -> Option<char> {
    match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" | "#39" => Some('\''),
        "nbsp" => Some(' '),
        _ if entity.starts_with("#x") || entity.starts_with("#X") => {
            u32::from_str_radix(&entity[2..], 16)
                .ok()
                .and_then(char::from_u32)
        }
        _ if entity.starts_with('#') => entity[1..].parse().ok().and_then(char::from_u32),
        _ => None,
    }
}

fn normalize_whitespace(input: &str, mode: ExtractMode) -> String {
    let mut output = String::with_capacity(input.len());
    let mut previous_space = false;
    let mut newline_count = 0;
    let max_newlines = if mode == ExtractMode::Markdown { 2 } else { 1 };
    for character in input.chars() {
        if character == '\n' {
            while output.ends_with(' ') {
                output.pop();
            }
            newline_count += 1;
            if newline_count <= max_newlines && !output.is_empty() {
                output.push('\n');
            }
            previous_space = false;
        } else if character.is_whitespace() {
            newline_count = 0;
            if !previous_space && !output.ends_with('\n') && !output.is_empty() {
                output.push(' ');
            }
            previous_space = true;
        } else {
            newline_count = 0;
            output.push(character);
            previous_space = false;
        }
    }
    output.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_article_and_removes_navigation_and_scripts() {
        let html = r#"
          <html><head><title>Doc &amp; Guide</title></head><body>
            <nav>Menu</nav>
            <article><h1>Hello</h1><script>secret()</script>
              <p>Useful &lt;text&gt;.</p><ul><li>One</li><li>Two</li></ul>
            </article>
          </body></html>
        "#;
        let extracted = extract_web_content(html, "text/html", ExtractMode::Markdown);
        assert_eq!(extracted.title.as_deref(), Some("Doc & Guide"));
        assert_eq!(extracted.extractor, "article");
        assert!(extracted.text.contains("# Hello"));
        assert!(extracted.text.contains("Useful <text>."));
        assert!(extracted.text.contains("- One"));
        assert!(!extracted.text.contains("Menu"));
        assert!(!extracted.text.contains("secret"));
    }

    #[test]
    fn text_mode_omits_markdown_markers() {
        let extracted = extract_web_content(
            "<main><h2>Title</h2><li>Item</li></main>",
            "text/html",
            ExtractMode::Text,
        );
        assert_eq!(extracted.text, "Title\nItem");
    }

    #[test]
    fn preserves_markdown_and_plain_payloads() {
        let markdown = extract_web_content("# Existing", "text/markdown", ExtractMode::Markdown);
        assert_eq!(markdown.text, "# Existing");
        assert_eq!(markdown.extractor, "markdown");

        let json = extract_web_content(r#"{"ok":true}"#, "application/json", ExtractMode::Text);
        assert_eq!(json.text, r#"{"ok":true}"#);
        assert_eq!(json.extractor, "plain");
    }

    #[test]
    fn decodes_named_decimal_and_hex_entities() {
        assert_eq!(
            html_fragment_to_text("A&nbsp;&amp;&#33;&#x21;", ExtractMode::Text),
            "A &!!"
        );
    }
}
