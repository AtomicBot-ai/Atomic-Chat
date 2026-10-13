//! Turns what each runtime reports into one shape Helix can read, and decides
//! which layer a request's tokens are counted at.
//!
//! Engines report in two ways: aggregate Prometheus counters (llama.cpp with
//! `--metrics`, vLLM, SGLang, TGI) and per-request fields on the response
//! (Ollama's nanosecond durations, llama.cpp's `timings`, OpenAI `usage`).
//! Both land in the structs below. Wrappers pass requests on to an engine, so a
//! request is counted once, at the deepest layer that reported tokens, and
//! attributed to the engine that did the work.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use super::descriptor::Layer;

// --- Prometheus text format ---------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Sample {
    pub name: String,
    pub labels: BTreeMap<String, String>,
    pub value: f64,
}

/// Parses Prometheus text exposition. Comment, `# HELP` and `# TYPE` lines
/// and lines that do not parse are skipped: one odd line from a runtime must
/// not blank the whole scrape.
pub fn parse_prometheus(text: &str) -> Vec<Sample> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(parse_sample_line)
        .collect()
}

fn parse_sample_line(line: &str) -> Option<Sample> {
    let (name, labels, rest) = match line.find('{') {
        Some(open) if line[..open].find(char::is_whitespace).is_none() => {
            let (labels, after) = parse_labels(&line[open + 1..])?;
            (line[..open].to_string(), labels, after)
        }
        _ => {
            let mut parts = line.splitn(2, char::is_whitespace);
            let name = parts.next()?.to_string();
            (name, BTreeMap::new(), parts.next()?)
        }
    };
    if name.is_empty() {
        return None;
    }
    // The value, optionally followed by a timestamp.
    let value = parse_value(rest.split_whitespace().next()?)?;
    Some(Sample {
        name,
        labels,
        value,
    })
}

/// Parses `a="x",b="y"}` and returns the labels and whatever follows the `}`.
fn parse_labels(input: &str) -> Option<(BTreeMap<String, String>, &str)> {
    let mut labels = BTreeMap::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    loop {
        while i < bytes.len() && (bytes[i] == b',' || bytes[i].is_ascii_whitespace()) {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }
        if bytes[i] == b'}' {
            return Some((labels, &input[i + 1..]));
        }
        let key_start = i;
        while i < bytes.len() && bytes[i] != b'=' {
            i += 1;
        }
        let key = input.get(key_start..i)?.trim().to_string();
        i += 1; // '='
        if bytes.get(i) != Some(&b'"') {
            return None;
        }
        i += 1;
        let mut value = String::new();
        loop {
            match bytes.get(i)? {
                b'\\' => {
                    match bytes.get(i + 1)? {
                        b'n' => value.push('\n'),
                        other => value.push(*other as char),
                    }
                    i += 2;
                }
                b'"' => {
                    i += 1;
                    break;
                }
                _ => {
                    // Copy one whole UTF-8 character.
                    let ch = input[i..].chars().next()?;
                    value.push(ch);
                    i += ch.len_utf8();
                }
            }
        }
        labels.insert(key, value);
    }
}

fn parse_value(text: &str) -> Option<f64> {
    match text {
        "+Inf" | "Inf" => Some(f64::INFINITY),
        "-Inf" => Some(f64::NEG_INFINITY),
        "NaN" => Some(f64::NAN),
        other => other.parse().ok(),
    }
}

// --- engine counters ------------------------------------------------------------

/// The numbers Helix shows for a running engine, from its metrics endpoint.
/// `None` means the engine does not report that number.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct EngineCounters {
    pub prompt_tokens_total: Option<f64>,
    pub generated_tokens_total: Option<f64>,
    pub requests_running: Option<f64>,
    pub requests_waiting: Option<f64>,
    /// 0.0-1.0.
    pub kv_cache_usage: Option<f64>,
}

/// Which metric names mean what, per engine metric namespace.
struct MetricMap {
    prompt_tokens: &'static [&'static str],
    generated_tokens: &'static [&'static str],
    running: &'static [&'static str],
    waiting: &'static [&'static str],
    /// (metric, divide by) - vLLM reports a ratio, some versions a percentage.
    kv_usage: &'static [(&'static str, f64)],
}

fn metric_map(prefix: &str) -> Option<MetricMap> {
    Some(match prefix {
        "llamacpp:" => MetricMap {
            prompt_tokens: &["llamacpp:prompt_tokens_total"],
            generated_tokens: &["llamacpp:tokens_predicted_total"],
            running: &["llamacpp:requests_processing"],
            waiting: &["llamacpp:requests_deferred"],
            kv_usage: &[("llamacpp:kv_cache_usage_ratio", 1.0)],
        },
        "vllm:" => MetricMap {
            prompt_tokens: &["vllm:prompt_tokens_total"],
            generated_tokens: &["vllm:generation_tokens_total"],
            running: &["vllm:num_requests_running"],
            waiting: &["vllm:num_requests_waiting"],
            kv_usage: &[
                ("vllm:kv_cache_usage_perc", 1.0),
                ("vllm:gpu_cache_usage_perc", 1.0),
            ],
        },
        "sglang:" => MetricMap {
            prompt_tokens: &["sglang:prompt_tokens_total"],
            generated_tokens: &["sglang:generation_tokens_total"],
            running: &["sglang:num_running_reqs"],
            waiting: &["sglang:num_queue_reqs"],
            kv_usage: &[("sglang:token_usage", 1.0)],
        },
        "tgi_" => MetricMap {
            prompt_tokens: &["tgi_request_input_length_sum"],
            generated_tokens: &["tgi_request_generated_tokens_sum"],
            running: &["tgi_batch_current_size"],
            waiting: &["tgi_queue_size"],
            kv_usage: &[],
        },
        _ => return None,
    })
}

/// Reads an engine's counters from a scrape. Returns `None` for a namespace
/// this module has no mapping for.
///
/// Label sets are summed (one per model or per engine), except that SGLang's
/// per-rank series are counted from tensor-parallel rank 0 only: with
/// `--enable-metrics-for-all-schedulers` every rank records the same request.
pub fn engine_counters(prefix: &str, samples: &[Sample]) -> Option<EngineCounters> {
    let map = metric_map(prefix)?;
    let counted = |sample: &&Sample| match sample.labels.get("tp_rank") {
        Some(rank) => rank == "0",
        None => true,
    };
    let sum = |names: &[&str]| -> Option<f64> {
        let mut found = false;
        let mut total = 0.0;
        for sample in samples.iter().filter(counted) {
            if names.contains(&sample.name.as_str()) && sample.value.is_finite() {
                found = true;
                total += sample.value;
            }
        }
        found.then_some(total)
    };
    // The first name that is present wins, so a renamed metric is not added
    // to its old name.
    let first_present = |names: &[&str]| -> Option<f64> {
        names.iter().find_map(|name| sum(&[name]))
    };
    let kv_cache_usage = map.kv_usage.iter().find_map(|(name, scale)| {
        let values: Vec<f64> = samples
            .iter()
            .filter(counted)
            .filter(|s| s.name == *name && s.value.is_finite())
            .map(|s| s.value / scale)
            .collect();
        // A ratio is averaged across label sets, not summed.
        (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
    });
    Some(EngineCounters {
        prompt_tokens_total: first_present(map.prompt_tokens),
        generated_tokens_total: first_present(map.generated_tokens),
        requests_running: first_present(map.running),
        requests_waiting: first_present(map.waiting),
        kv_cache_usage,
    })
}

// --- per-request timings ----------------------------------------------------------

/// One request's numbers, whatever the runtime called them.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct RequestTimings {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    /// Prompt tokens served from the cache instead of evaluated.
    pub cached_prompt_tokens: Option<u64>,
    pub load_ms: Option<f64>,
    pub prompt_ms: Option<f64>,
    pub generation_ms: Option<f64>,
    pub total_ms: Option<f64>,
}

impl RequestTimings {
    /// Generated tokens per second, when both numbers are known.
    pub fn tokens_per_second(&self) -> Option<f64> {
        let tokens = self.completion_tokens? as f64;
        let ms = self.generation_ms?;
        (ms > 0.0).then(|| tokens * 1000.0 / ms)
    }
}

fn as_u64(value: &Value, key: &str) -> Option<u64> {
    value.get(key)?.as_u64()
}

fn as_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key)?.as_f64()
}

/// Ollama's final `/api/chat` or `/api/generate` object. Durations are in
/// nanoseconds.
pub fn from_ollama(response: &Value) -> RequestTimings {
    let ms = |key| as_f64(response, key).map(|ns| ns / 1_000_000.0);
    RequestTimings {
        prompt_tokens: as_u64(response, "prompt_eval_count"),
        completion_tokens: as_u64(response, "eval_count"),
        cached_prompt_tokens: as_u64(response, "prompt_eval_cached_count"),
        load_ms: ms("load_duration"),
        prompt_ms: ms("prompt_eval_duration"),
        generation_ms: ms("eval_duration"),
        total_ms: ms("total_duration"),
    }
}

/// llama.cpp server's `timings` object (on `/completion` and on OpenAI
/// responses from `llama-server`).
pub fn from_llama_cpp(response: &Value) -> RequestTimings {
    let timings = response.get("timings").unwrap_or(response);
    let prompt_ms = as_f64(timings, "prompt_ms");
    let generation_ms = as_f64(timings, "predicted_ms");
    RequestTimings {
        prompt_tokens: as_u64(timings, "prompt_n"),
        completion_tokens: as_u64(timings, "predicted_n"),
        cached_prompt_tokens: as_u64(timings, "cache_n"),
        load_ms: None,
        prompt_ms,
        generation_ms,
        total_ms: match (prompt_ms, generation_ms) {
            (Some(prompt), Some(generation)) => Some(prompt + generation),
            _ => None,
        },
    }
}

/// An OpenAI `usage` object, on the response or its last stream chunk.
pub fn from_openai_usage(response: &Value) -> RequestTimings {
    let usage = response.get("usage").unwrap_or(response);
    RequestTimings {
        prompt_tokens: as_u64(usage, "prompt_tokens"),
        completion_tokens: as_u64(usage, "completion_tokens"),
        cached_prompt_tokens: usage
            .get("prompt_tokens_details")
            .and_then(|details| as_u64(details, "cached_tokens")),
        ..RequestTimings::default()
    }
}

// --- attribution ------------------------------------------------------------------

/// What one layer saw of one request.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Span {
    pub request_id: String,
    /// Catalog id of the runtime that recorded this span.
    pub runtime: String,
    pub layer: Layer,
    /// Catalog id of the engine that did the work, when this layer knows it.
    pub backend: Option<String>,
    /// 0 for the facade, growing inward.
    pub depth: u8,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub duration_ms: Option<f64>,
}

/// A request's tokens after attribution: counted once, charged to one engine.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Attributed {
    pub request_id: String,
    pub engine: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Every layer's duration, outermost first, for the latency breakdown.
    pub layer_ms: Vec<(String, f64)>,
}

/// Attributes each request's tokens to exactly one engine.
///
/// The tokens come from the deepest span that reported any, because an inner
/// layer's count is the engine's own. They are charged to that span's
/// `backend` if it names one, else to its runtime. Spans from wrappers and the
/// facade contribute latency only.
pub fn attribute(spans: &[Span]) -> Vec<Attributed> {
    let mut by_request: BTreeMap<&str, Vec<&Span>> = BTreeMap::new();
    for span in spans {
        by_request
            .entry(span.request_id.as_str())
            .or_default()
            .push(span);
    }
    by_request
        .into_iter()
        .filter_map(|(request_id, mut spans)| {
            spans.sort_by_key(|span| span.depth);
            let counted = spans
                .iter()
                .rev()
                .find(|span| span.prompt_tokens.is_some() || span.completion_tokens.is_some())?;
            let engine = counted
                .backend
                .clone()
                .unwrap_or_else(|| counted.runtime.clone());
            Some(Attributed {
                request_id: request_id.to_string(),
                engine,
                prompt_tokens: counted.prompt_tokens.unwrap_or(0),
                completion_tokens: counted.completion_tokens.unwrap_or(0),
                layer_ms: spans
                    .iter()
                    .filter_map(|span| Some((span.runtime.clone(), span.duration_ms?)))
                    .collect(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Trimmed from a llama-server `--metrics` scrape.
    const LLAMA_CPP: &str = r#"# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed.
# TYPE llamacpp:prompt_tokens_total counter
llamacpp:prompt_tokens_total 1234
# HELP llamacpp:tokens_predicted_total Number of generation tokens processed.
# TYPE llamacpp:tokens_predicted_total counter
llamacpp:tokens_predicted_total 5678
llamacpp:prompt_seconds_total 2.5
llamacpp:requests_processing 1
llamacpp:requests_deferred 0
"#;

    const VLLM: &str = r#"# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="Qwen/Qwen3-32B-AWQ"} 3.0
vllm:num_requests_waiting{engine="0",model_name="Qwen/Qwen3-32B-AWQ"} 1.0
vllm:kv_cache_usage_perc{engine="0",model_name="Qwen/Qwen3-32B-AWQ"} 0.42
vllm:prompt_tokens_total{engine="0",model_name="Qwen/Qwen3-32B-AWQ"} 1000.0
vllm:generation_tokens_total{engine="0",model_name="Qwen/Qwen3-32B-AWQ"} 250.0
vllm:time_to_first_token_seconds_bucket{engine="0",le="+Inf",model_name="Qwen/Qwen3-32B-AWQ"} 12
"#;

    #[test]
    fn prometheus_lines_with_and_without_labels_parse() {
        let samples = parse_prometheus(VLLM);
        assert_eq!(samples.len(), 6);
        assert_eq!(samples[0].name, "vllm:num_requests_running");
        assert_eq!(samples[0].labels["model_name"], "Qwen/Qwen3-32B-AWQ");
        assert_eq!(samples[0].value, 3.0);
        assert_eq!(samples[5].labels["le"], "+Inf");

        let plain = parse_prometheus("up 1 1700000000000\n");
        assert_eq!(plain[0].name, "up");
        assert_eq!(plain[0].value, 1.0);
    }

    #[test]
    fn escaped_label_values_and_odd_lines_are_handled() {
        let samples = parse_prometheus(
            "a{path=\"C:\\\\models\\\\q\\\"x\\\"\",n=\"é\"} 2\nnot a metric line\nb{broken 1\nc NaN\n",
        );
        assert_eq!(samples.len(), 2, "{samples:?}");
        assert_eq!(samples[0].labels["path"], r#"C:\models\q"x""#);
        assert_eq!(samples[0].labels["n"], "é");
        assert!(samples[1].value.is_nan());
    }

    #[test]
    fn llama_cpp_counters_are_read() {
        let counters = engine_counters("llamacpp:", &parse_prometheus(LLAMA_CPP)).unwrap();
        assert_eq!(counters.prompt_tokens_total, Some(1234.0));
        assert_eq!(counters.generated_tokens_total, Some(5678.0));
        assert_eq!(counters.requests_running, Some(1.0));
        assert_eq!(counters.requests_waiting, Some(0.0));
        assert_eq!(counters.kv_cache_usage, None, "newer builds dropped it");
    }

    #[test]
    fn vllm_counters_are_read() {
        let counters = engine_counters("vllm:", &parse_prometheus(VLLM)).unwrap();
        assert_eq!(counters.prompt_tokens_total, Some(1000.0));
        assert_eq!(counters.generated_tokens_total, Some(250.0));
        assert_eq!(counters.requests_running, Some(3.0));
        assert_eq!(counters.kv_cache_usage, Some(0.42));
    }

    #[test]
    fn sglang_per_rank_series_are_counted_from_rank_0_only() {
        let text = r#"sglang:prompt_tokens_total{model_name="m",tp_rank="0"} 100
sglang:prompt_tokens_total{model_name="m",tp_rank="1"} 100
sglang:generation_tokens_total{model_name="m",tp_rank="0"} 40
sglang:generation_tokens_total{model_name="m",tp_rank="1"} 40
sglang:token_usage{model_name="m",tp_rank="0"} 0.5
sglang:token_usage{model_name="m",tp_rank="1"} 0.5
"#;
        let counters = engine_counters("sglang:", &parse_prometheus(text)).unwrap();
        assert_eq!(counters.prompt_tokens_total, Some(100.0));
        assert_eq!(counters.generated_tokens_total, Some(40.0));
        assert_eq!(counters.kv_cache_usage, Some(0.5));
    }

    #[test]
    fn two_models_on_one_engine_are_summed() {
        let text = "vllm:prompt_tokens_total{model_name=\"a\"} 10\nvllm:prompt_tokens_total{model_name=\"b\"} 5\n";
        let counters = engine_counters("vllm:", &parse_prometheus(text)).unwrap();
        assert_eq!(counters.prompt_tokens_total, Some(15.0));
    }

    #[test]
    fn an_unknown_namespace_has_no_counters() {
        assert!(engine_counters("dynamo_", &[]).is_none());
    }

    #[test]
    fn ollama_nanoseconds_become_milliseconds() {
        let timings = from_ollama(&json!({
            "model": "qwen3:8b",
            "done": true,
            "total_duration": 5_043_500_667u64,
            "load_duration": 5_025_959u64,
            "prompt_eval_count": 26,
            "prompt_eval_duration": 325_953_000u64,
            "eval_count": 290,
            "eval_duration": 4_709_213_000u64
        }));
        assert_eq!(timings.prompt_tokens, Some(26));
        assert_eq!(timings.completion_tokens, Some(290));
        assert_eq!(timings.prompt_ms, Some(325.953));
        assert!((timings.tokens_per_second().unwrap() - 61.58).abs() < 0.01);
    }

    #[test]
    fn llama_cpp_timings_are_read() {
        let timings = from_llama_cpp(&json!({
            "choices": [],
            "timings": {
                "cache_n": 12, "prompt_n": 30, "prompt_ms": 45.5,
                "predicted_n": 100, "predicted_ms": 1000.0, "predicted_per_second": 100.0
            }
        }));
        assert_eq!(timings.cached_prompt_tokens, Some(12));
        assert_eq!(timings.total_ms, Some(1045.5));
        assert_eq!(timings.tokens_per_second(), Some(100.0));
    }

    #[test]
    fn openai_usage_is_read() {
        let timings = from_openai_usage(&json!({
            "usage": {"prompt_tokens": 9, "completion_tokens": 12, "total_tokens": 21,
                      "prompt_tokens_details": {"cached_tokens": 4}}
        }));
        assert_eq!(timings.prompt_tokens, Some(9));
        assert_eq!(timings.completion_tokens, Some(12));
        assert_eq!(timings.cached_prompt_tokens, Some(4));
        assert_eq!(timings.tokens_per_second(), None);
    }

    fn span(runtime: &str, layer: Layer, depth: u8, tokens: Option<(u64, u64)>) -> Span {
        Span {
            request_id: "req-1".into(),
            runtime: runtime.into(),
            layer,
            backend: None,
            depth,
            prompt_tokens: tokens.map(|t| t.0),
            completion_tokens: tokens.map(|t| t.1),
            duration_ms: Some(10.0 * f64::from(depth + 1)),
        }
    }

    #[test]
    fn a_request_through_facade_wrapper_and_engine_is_counted_once_at_the_engine() {
        // Radium's facade and TabbyAPI both echo the usage the engine reported.
        let mut tabby = span("tabbyapi", Layer::Wrapper, 1, Some((50, 20)));
        tabby.backend = Some("exllamav3".into());
        let spans = vec![
            span("radium", Layer::Wrapper, 0, Some((50, 20))),
            tabby,
        ];
        let attributed = attribute(&spans);
        assert_eq!(attributed.len(), 1);
        assert_eq!(attributed[0].engine, "exllamav3");
        assert_eq!(attributed[0].prompt_tokens, 50);
        assert_eq!(attributed[0].completion_tokens, 20);
        assert_eq!(attributed[0].layer_ms.len(), 2);
    }

    #[test]
    fn the_engines_own_count_wins_over_a_wrappers() {
        let spans = vec![
            span("localai", Layer::Wrapper, 1, Some((999, 999))),
            span("llama-cpp", Layer::Engine, 2, Some((40, 8))),
            span("radium", Layer::Wrapper, 0, None),
        ];
        let attributed = attribute(&spans);
        assert_eq!(attributed[0].engine, "llama-cpp");
        assert_eq!(attributed[0].prompt_tokens, 40);
        assert_eq!(
            attributed[0].layer_ms.iter().map(|(r, _)| r.as_str()).collect::<Vec<_>>(),
            ["radium", "localai", "llama-cpp"]
        );
    }

    #[test]
    fn a_request_nobody_counted_is_not_invented() {
        let spans = vec![span("comfyui", Layer::Engine, 1, None)];
        assert!(attribute(&spans).is_empty());
    }
}
