use serde::Serialize;
use url::Url;

use super::web_extract::{html_fragment_to_text, ExtractMode};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(super) struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum DuckDuckGoPage {
    Results(Vec<WebSearchResult>),
    Blocked,
    Empty,
}

pub(super) fn parse_duckduckgo_page(html: &str, max_results: usize) -> DuckDuckGoPage {
    let anchors = elements_with_class(html, "result__a");
    if anchors.is_empty() {
        return if is_bot_challenge(html) {
            DuckDuckGoPage::Blocked
        } else {
            DuckDuckGoPage::Empty
        };
    }

    let mut results = Vec::with_capacity(max_results.min(anchors.len()));
    for (index, anchor) in anchors.iter().enumerate() {
        if results.len() == max_results {
            break;
        }
        let Some(href) = attribute_value(anchor.opening_tag, "href") else {
            continue;
        };
        let Some(url) = normalize_duckduckgo_href(&href) else {
            continue;
        };
        let title = html_fragment_to_text(anchor.inner_html, ExtractMode::Text);
        if title.is_empty() {
            continue;
        }
        let result_end = anchors
            .get(index + 1)
            .map(|next| next.start)
            .unwrap_or(html.len());
        let snippet = elements_with_class(&html[anchor.end..result_end], "result__snippet")
            .first()
            .map(|element| html_fragment_to_text(element.inner_html, ExtractMode::Text))
            .unwrap_or_default();
        results.push(WebSearchResult {
            title,
            url,
            snippet,
        });
    }

    if results.is_empty() {
        DuckDuckGoPage::Empty
    } else {
        DuckDuckGoPage::Results(results)
    }
}

pub(super) fn is_bot_challenge(html: &str) -> bool {
    if contains_ascii_case_insensitive(html, "result__a") {
        return false;
    }
    [
        "challenge-form",
        "g-recaptcha",
        "hcaptcha",
        "captcha",
        "are you a human",
        "verify you are human",
        "automated requests",
    ]
    .iter()
    .any(|marker| contains_ascii_case_insensitive(html, marker))
}

pub(super) fn normalize_duckduckgo_href(raw_href: &str) -> Option<String> {
    let base = Url::parse("https://html.duckduckgo.com").ok()?;
    let decoded_href = html_fragment_to_text(raw_href.trim(), ExtractMode::Text);
    let url = base.join(&decoded_href).ok()?;
    if url
        .host_str()
        .is_some_and(|host| host.ends_with("duckduckgo.com"))
    {
        let target = url
            .query_pairs()
            .find_map(|(name, value)| (name == "uddg").then(|| value.into_owned()))?;
        let target = Url::parse(&target).ok()?;
        if matches!(target.scheme(), "http" | "https") {
            return Some(target.into());
        }
        return None;
    }
    matches!(url.scheme(), "http" | "https").then(|| url.into())
}

#[derive(Debug)]
struct HtmlElement<'a> {
    start: usize,
    end: usize,
    opening_tag: &'a str,
    inner_html: &'a str,
}

fn elements_with_class<'a>(html: &'a str, class_name: &str) -> Vec<HtmlElement<'a>> {
    let mut elements = Vec::new();
    let mut cursor = 0;
    while let Some(relative_open) = html[cursor..].find('<') {
        let start = cursor + relative_open;
        let Some(relative_tag_end) = html[start..].find('>') else {
            break;
        };
        let tag_end = start + relative_tag_end;
        let opening_tag = &html[start + 1..tag_end];
        cursor = tag_end + 1;
        if opening_tag
            .chars()
            .next()
            .is_some_and(|character| matches!(character, '/' | '!' | '?'))
            || !attribute_value(opening_tag, "class").is_some_and(|classes| {
                classes
                    .split_ascii_whitespace()
                    .any(|class| class == class_name)
            })
        {
            continue;
        }
        let Some(tag_name) = opening_tag
            .split_ascii_whitespace()
            .next()
            .map(|name| name.trim_end_matches('/'))
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let close_pattern = format!("</{tag_name}>");
        let Some(close) = find_ascii_case_insensitive(html, &close_pattern, cursor) else {
            continue;
        };
        elements.push(HtmlElement {
            start,
            end: close + close_pattern.len(),
            opening_tag,
            inner_html: &html[tag_end + 1..close],
        });
    }
    elements
}

fn attribute_value(tag: &str, wanted: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut cursor = tag.find(char::is_whitespace).unwrap_or(tag.len());
    while cursor < bytes.len() {
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] == b'/' {
            break;
        }
        let name_start = cursor;
        while cursor < bytes.len() && !bytes[cursor].is_ascii_whitespace() && bytes[cursor] != b'='
        {
            cursor += 1;
        }
        let name = &tag[name_start..cursor];
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'=' {
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let (value_start, value_end) =
            if cursor < bytes.len() && matches!(bytes[cursor], b'"' | b'\'') {
                let quote = bytes[cursor];
                cursor += 1;
                let start = cursor;
                while cursor < bytes.len() && bytes[cursor] != quote {
                    cursor += 1;
                }
                let end = cursor;
                cursor = (cursor + 1).min(bytes.len());
                (start, end)
            } else {
                let start = cursor;
                while cursor < bytes.len()
                    && !bytes[cursor].is_ascii_whitespace()
                    && bytes[cursor] != b'/'
                {
                    cursor += 1;
                }
                (start, cursor)
            };
        if name.eq_ignore_ascii_case(wanted) {
            return Some(tag[value_start..value_end].to_owned());
        }
    }
    None
}

fn contains_ascii_case_insensitive(haystack: &str, needle: &str) -> bool {
    find_ascii_case_insensitive(haystack, needle, 0).is_some()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_structured_results_and_decodes_redirect_urls() {
        let html = r#"
          <div class="result">
            <a data-x="1" class="link result__a" href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.com%2Fdoc">
              Example <b>Doc</b>
            </a>
            <a class='result__snippet'>A useful &amp; precise snippet.</a>
          </div>
        "#;
        assert_eq!(
            parse_duckduckgo_page(html, 5),
            DuckDuckGoPage::Results(vec![WebSearchResult {
                title: "Example Doc".to_owned(),
                url: "https://example.com/doc".to_owned(),
                snippet: "A useful & precise snippet.".to_owned(),
            }])
        );
    }

    #[test]
    fn accepts_direct_result_urls_and_honors_max_results() {
        let html = r#"
          <a class="result__a" href="https://one.example/a">One</a>
          <span class="result__snippet">First</span>
          <a class="result__a" href="https://two.example/b">Two</a>
          <span class="result__snippet">Second</span>
        "#;
        let DuckDuckGoPage::Results(results) = parse_duckduckgo_page(html, 1) else {
            panic!("expected results");
        };
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://one.example/a");
    }

    #[test]
    fn detects_challenges_but_not_real_empty_or_result_pages() {
        assert_eq!(
            parse_duckduckgo_page(r#"<form class="challenge-form"></form>"#, 5),
            DuckDuckGoPage::Blocked
        );
        assert_eq!(
            parse_duckduckgo_page("<div>Are you a human?</div>", 5),
            DuckDuckGoPage::Blocked
        );
        assert_eq!(
            parse_duckduckgo_page("<div>No results found.</div>", 5),
            DuckDuckGoPage::Empty
        );
        assert!(!is_bot_challenge(
            r#"<a class="result__a" href="https://example.com">x</a> captcha"#
        ));
    }

    #[test]
    fn rejects_unsafe_or_unresolved_duckduckgo_links() {
        assert_eq!(
            normalize_duckduckgo_href("/l/?uddg=javascript%3Aalert%281%29"),
            None
        );
        assert_eq!(normalize_duckduckgo_href("/about"), None);
    }
}
