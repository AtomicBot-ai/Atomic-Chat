use super::helpers::*;
use super::models::*;
use crate::core::app::commands::get_jan_data_folder_path;
use hyper::body::Bytes;
use hyper::header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use reqwest::header::HeaderMap;
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::test::mock_app;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
enum TestRangeBehavior {
    Supported,
    Unsupported,
    Mismatched,
}

async fn spawn_interrupted_download_server(
    range_behavior: TestRangeBehavior,
) -> (
    String,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<Result<(), hyper::Error>>,
) {
    let request_count = Arc::new(AtomicUsize::new(0));
    let service_count = request_count.clone();
    let make_service = make_service_fn(move |_| {
        let service_count = service_count.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                let service_count = service_count.clone();
                async move {
                    let request_index = service_count.fetch_add(1, Ordering::SeqCst);
                    let response = if request_index == 0 {
                        let (mut sender, body) = Body::channel();
                        tokio::spawn(async move {
                            sender.send_data(Bytes::from_static(b"abc")).await.unwrap();
                            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                            sender.abort();
                        });
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(CONTENT_LENGTH, "6")
                            .body(body)
                            .unwrap()
                    } else if request.headers().get(RANGE).is_some() {
                        match range_behavior {
                            TestRangeBehavior::Supported => Response::builder()
                                .status(StatusCode::PARTIAL_CONTENT)
                                .header(CONTENT_RANGE, "bytes 3-5/6")
                                .body(Body::from("def"))
                                .unwrap(),
                            TestRangeBehavior::Mismatched => Response::builder()
                                .status(StatusCode::PARTIAL_CONTENT)
                                .header(CONTENT_RANGE, "bytes 2-5/6")
                                .body(Body::from("cdef"))
                                .unwrap(),
                            TestRangeBehavior::Unsupported => Response::builder()
                                .status(StatusCode::OK)
                                .body(Body::from("abcdef"))
                                .unwrap(),
                        }
                    } else {
                        Response::builder()
                            .status(StatusCode::OK)
                            .body(Body::from("abcdef"))
                            .unwrap()
                    };
                    Ok::<_, Infallible>(response)
                }
            }))
        }
    });
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let server = Server::from_tcp(listener).unwrap().serve(make_service);
    let handle = tokio::spawn(server);
    (
        format!("http://{address}/model.gguf"),
        request_count,
        handle,
    )
}

async fn spawn_preflight_head_server(
    failures_before_success: usize,
    fail_status: StatusCode,
) -> (
    String,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<Result<(), hyper::Error>>,
) {
    let request_count = Arc::new(AtomicUsize::new(0));
    let service_count = request_count.clone();
    let make_service = make_service_fn(move |_| {
        let service_count = service_count.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |_request: Request<Body>| {
                let service_count = service_count.clone();
                async move {
                    let request_index = service_count.fetch_add(1, Ordering::SeqCst);
                    let response = if request_index < failures_before_success {
                        Response::builder()
                            .status(fail_status)
                            .body(Body::empty())
                            .unwrap()
                    } else {
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(CONTENT_LENGTH, "42")
                            .body(Body::empty())
                            .unwrap()
                    };
                    Ok::<_, Infallible>(response)
                }
            }))
        }
    });
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let server = Server::from_tcp(listener).unwrap().serve(make_service);
    let handle = tokio::spawn(server);
    (
        format!("http://{address}/model.gguf"),
        request_count,
        handle,
    )
}

fn preflight_test_item(url: String, size: Option<u64>) -> DownloadItem {
    DownloadItem {
        url,
        save_path: "models/test/model.gguf".to_string(),
        proxy: None,
        sha256: None,
        size,
        model_id: None,
    }
}

#[tokio::test]
async fn preflight_uses_catalog_size_without_a_head_request() {
    let (url, request_count, server) = spawn_preflight_head_server(0, StatusCode::OK).await;
    let item = preflight_test_item(url, Some(6));
    let client = reqwest::Client::new();
    let size = preflight_file_size(&client, &item, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(size, 6);
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
async fn preflight_aborts_before_request_when_cancelled() {
    let (url, request_count, server) = spawn_preflight_head_server(0, StatusCode::OK).await;
    let item = preflight_test_item(url, None);
    let client = reqwest::Client::new();
    let cancel_token = CancellationToken::new();
    cancel_token.cancel();

    let error = preflight_file_size(&client, &item, &cancel_token)
        .await
        .unwrap_err();

    assert_eq!(error, "Download cancelled");
    assert_eq!(request_count.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
async fn preflight_head_retries_transient_failures() {
    let (url, request_count, server) =
        spawn_preflight_head_server(2, StatusCode::INTERNAL_SERVER_ERROR).await;
    let item = preflight_test_item(url, None);
    let client = reqwest::Client::new();
    let size = preflight_file_size(&client, &item, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(size, 42);
    assert_eq!(request_count.load(Ordering::SeqCst), 3);
    server.abort();
}

#[tokio::test]
async fn preflight_head_failure_is_not_fatal() {
    let (url, request_count, server) =
        spawn_preflight_head_server(usize::MAX, StatusCode::INTERNAL_SERVER_ERROR).await;
    let item = preflight_test_item(url, None);
    let client = reqwest::Client::new();
    let size = preflight_file_size(&client, &item, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(size, 0);
    // Initial attempt plus MAX_STREAM_RETRIES retries.
    assert_eq!(request_count.load(Ordering::SeqCst), 6);
    server.abort();
}

/// Accepts TCP connections and slams the first `connection_drops` of them
/// shut before sending any HTTP response, mimicking the transport-level
/// failures from the ATO-302 report (TLS handshake EOF, connection reset).
/// Later connections get a well-formed HEAD response.
async fn spawn_connection_dropping_head_server(
    connection_drops: usize,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let attempt_count = Arc::new(AtomicUsize::new(0));
    let server_count = attempt_count.clone();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let attempt = server_count.fetch_add(1, Ordering::SeqCst);
            if attempt < connection_drops {
                drop(socket);
                continue;
            }
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let _ = socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-length: 42\r\nconnection: close\r\n\r\n",
                )
                .await;
        }
    });
    (
        format!("http://{address}/model.gguf"),
        attempt_count,
        handle,
    )
}

#[tokio::test]
async fn preflight_head_retries_dropped_connections() {
    let (url, attempt_count, server) = spawn_connection_dropping_head_server(2).await;
    let item = preflight_test_item(url, None);
    let client = reqwest::Client::new();
    let size = preflight_file_size(&client, &item, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(size, 42);
    assert_eq!(attempt_count.load(Ordering::SeqCst), 3);
    server.abort();
}

async fn spawn_head_fails_get_succeeds_server() -> (
    String,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<Result<(), hyper::Error>>,
) {
    let head_count = Arc::new(AtomicUsize::new(0));
    let get_count = Arc::new(AtomicUsize::new(0));
    let service_head_count = head_count.clone();
    let service_get_count = get_count.clone();
    let make_service = make_service_fn(move |_| {
        let head_count = service_head_count.clone();
        let get_count = service_get_count.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                let head_count = head_count.clone();
                let get_count = get_count.clone();
                async move {
                    let response = if request.method() == Method::HEAD {
                        head_count.fetch_add(1, Ordering::SeqCst);
                        Response::builder()
                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                            .body(Body::empty())
                            .unwrap()
                    } else {
                        get_count.fetch_add(1, Ordering::SeqCst);
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(CONTENT_LENGTH, "6")
                            .body(Body::from("abcdef"))
                            .unwrap()
                    };
                    Ok::<_, Infallible>(response)
                }
            }))
        }
    });
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let server = Server::from_tcp(listener).unwrap().serve(make_service);
    let handle = tokio::spawn(server);
    (
        format!("http://{address}/model.gguf"),
        head_count,
        get_count,
        handle,
    )
}

// Regression test for ATO-302: a permanently failing preflight HEAD used to
// abort the whole download; now the download must still complete via GET.
#[tokio::test]
async fn download_succeeds_when_preflight_head_always_fails() {
    let (url, head_count, get_count, server) = spawn_head_fails_get_succeeds_server().await;
    let item = DownloadItem {
        url,
        save_path: "models/test-ato-302/model.gguf".to_string(),
        proxy: None,
        sha256: None,
        size: None,
        model_id: Some("test/ato-302".to_string()),
    };
    let app = mock_app();

    _download_files_internal(
        app.handle().clone(),
        std::slice::from_ref(&item),
        &HashMap::new(),
        "ato-302-test",
        false,
        CancellationToken::new(),
    )
    .await
    .unwrap();

    let data_dir = get_jan_data_folder_path(app.handle().clone());
    let saved = tokio::fs::read(data_dir.join(&item.save_path)).await.unwrap();
    assert_eq!(saved, b"abcdef");
    // Initial attempt plus MAX_STREAM_RETRIES retries, then the fallback.
    assert_eq!(head_count.load(Ordering::SeqCst), 6);
    assert_eq!(get_count.load(Ordering::SeqCst), 1);
    server.abort();
    let _ = tokio::fs::remove_dir_all(data_dir.join("models/test-ato-302")).await;
}

#[tokio::test]
async fn preflight_head_does_not_retry_fatal_status() {
    let (url, request_count, server) =
        spawn_preflight_head_server(usize::MAX, StatusCode::NOT_FOUND).await;
    let item = preflight_test_item(url, None);
    let client = reqwest::Client::new();
    let size = preflight_file_size(&client, &item, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(size, 0);
    assert_eq!(request_count.load(Ordering::SeqCst), 1);
    server.abort();
}

async fn spawn_model_contract_server() -> (String, tokio::task::JoinHandle<Result<(), hyper::Error>>)
{
    let make_service = make_service_fn(move |_| async move {
        Ok::<_, Infallible>(service_fn(|request: Request<Body>| async move {
            let response = if request.uri().path() == "/tiny-model.gguf" {
                Response::builder()
                    .status(StatusCode::OK)
                    .header(CONTENT_LENGTH, "6")
                    .header("content-type", "application/octet-stream")
                    .body(Body::from("abcdef"))
                    .unwrap()
            } else {
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::empty())
                    .unwrap()
            };
            Ok::<_, Infallible>(response)
        }))
    });
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let server = Server::from_tcp(listener).unwrap().serve(make_service);
    (
        format!("http://{address}/tiny-model.gguf"),
        tokio::spawn(server),
    )
}

fn test_download_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir()
        .join(format!(
            "atomic-chat-download-test-{}",
            uuid::Uuid::new_v4()
        ))
        .join(name)
}

async fn run_interrupted_download_test(
    range_behavior: TestRangeBehavior,
) -> (Vec<u8>, usize, std::path::PathBuf) {
    let (url, request_count, server) = spawn_interrupted_download_server(range_behavior).await;
    let save_path = test_download_path("model.gguf");
    let item = DownloadItem {
        url,
        save_path: save_path.to_string_lossy().into_owned(),
        proxy: None,
        sha256: None,
        size: Some(6),
        model_id: Some("test/model".to_string()),
    };
    let app = mock_app();
    download_single_file_for_test(app.handle().clone(), &item, &save_path, 6)
        .await
        .unwrap();
    let bytes = tokio::fs::read(&save_path).await.unwrap();
    let requests = request_count.load(Ordering::SeqCst);
    server.abort();
    (bytes, requests, save_path)
}

// Helper function to create a minimal proxy config for testing
fn create_test_proxy_config(url: &str) -> ProxyConfig {
    ProxyConfig {
        url: url.to_string(),
        username: None,
        password: None,
        no_proxy: None,
        ignore_ssl: None,
    }
}

#[test]
fn test_validate_proxy_config() {
    // Valid HTTP proxy
    let config = ProxyConfig {
        url: "http://proxy.example.com:8080".to_string(),
        username: Some("user".to_string()),
        password: Some("pass".to_string()),
        no_proxy: Some(vec!["localhost".to_string(), "*.example.com".to_string()]),
        ignore_ssl: Some(true),
    };
    assert!(validate_proxy_config(&config).is_ok());

    // Valid HTTPS proxy
    let config = ProxyConfig {
        url: "https://proxy.example.com:8080".to_string(),
        username: None,
        password: None,
        no_proxy: None,
        ignore_ssl: None,
    };
    assert!(validate_proxy_config(&config).is_ok());

    // Valid SOCKS5 proxy
    let config = ProxyConfig {
        url: "socks5://proxy.example.com:1080".to_string(),
        username: None,
        password: None,
        no_proxy: None,
        ignore_ssl: None,
    };
    assert!(validate_proxy_config(&config).is_ok());

    // Invalid URL
    let config = create_test_proxy_config("invalid-url");
    assert!(validate_proxy_config(&config).is_err());

    // Unsupported scheme
    let config = create_test_proxy_config("ftp://proxy.example.com:21");
    assert!(validate_proxy_config(&config).is_err());

    // Username without password
    let mut config = create_test_proxy_config("http://proxy.example.com:8080");
    config.username = Some("user".to_string());
    assert!(validate_proxy_config(&config).is_err());

    // Password without username
    let mut config = create_test_proxy_config("http://proxy.example.com:8080");
    config.password = Some("pass".to_string());
    assert!(validate_proxy_config(&config).is_err());

    // Empty no_proxy entry
    let mut config = create_test_proxy_config("http://proxy.example.com:8080");
    config.no_proxy = Some(vec!["".to_string()]);
    assert!(validate_proxy_config(&config).is_err());

    // Invalid wildcard pattern
    let mut config = create_test_proxy_config("http://proxy.example.com:8080");
    config.no_proxy = Some(vec!["*.".to_string()]);
    assert!(validate_proxy_config(&config).is_err());
}

#[test]
fn test_should_bypass_proxy() {
    let no_proxy = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "*.example.com".to_string(),
        "specific.domain.com".to_string(),
    ];

    // Should bypass for localhost
    assert!(should_bypass_proxy("http://localhost:8080/path", &no_proxy));

    // Should bypass for 127.0.0.1
    assert!(should_bypass_proxy("https://127.0.0.1:3000/api", &no_proxy));

    // Should bypass for wildcard match
    assert!(should_bypass_proxy(
        "http://sub.example.com/path",
        &no_proxy
    ));
    assert!(should_bypass_proxy("https://api.example.com/v1", &no_proxy));

    // Should bypass for specific domain
    assert!(should_bypass_proxy(
        "http://specific.domain.com/test",
        &no_proxy
    ));

    // Should NOT bypass for other domains
    assert!(!should_bypass_proxy("http://other.com/path", &no_proxy));
    assert!(!should_bypass_proxy("https://example.org/api", &no_proxy));

    // Should bypass everything with "*"
    let wildcard_no_proxy = vec!["*".to_string()];
    assert!(should_bypass_proxy(
        "http://any.domain.com/path",
        &wildcard_no_proxy
    ));

    // Empty no_proxy should not bypass anything
    let empty_no_proxy = vec![];
    assert!(!should_bypass_proxy(
        "http://any.domain.com/path",
        &empty_no_proxy
    ));
}

#[test]
fn test_create_proxy_from_config() {
    // Valid configuration should work
    let mut config = create_test_proxy_config("http://proxy.example.com:8080");
    config.username = Some("user".to_string());
    config.password = Some("pass".to_string());
    assert!(create_proxy_from_config(&config).is_ok());

    // Invalid configuration should fail
    let config = create_test_proxy_config("invalid-url");
    assert!(create_proxy_from_config(&config).is_err());
}

#[test]
fn test_convert_headers() {
    let mut headers = HashMap::new();
    headers.insert("User-Agent".to_string(), "test-agent".to_string());
    headers.insert("Authorization".to_string(), "Bearer token".to_string());

    let header_map = _convert_headers(&headers).unwrap();
    assert_eq!(header_map.len(), 2);
    assert_eq!(header_map.get("User-Agent").unwrap(), "test-agent");
    assert_eq!(header_map.get("Authorization").unwrap(), "Bearer token");
}

#[test]
fn test_proxy_ssl_verification_settings() {
    // Test proxy config with SSL verification settings
    let mut config = create_test_proxy_config("https://proxy.example.com:8080");
    config.ignore_ssl = Some(true);

    // Should validate successfully
    assert!(validate_proxy_config(&config).is_ok());

    // Test with all SSL settings as false
    config.ignore_ssl = Some(false);

    // Should still validate successfully
    assert!(validate_proxy_config(&config).is_ok());
}

#[test]
fn test_proxy_config_with_mixed_ssl_settings() {
    // Test with mixed SSL settings - ignore_ssl true, others false
    let mut config = create_test_proxy_config("https://proxy.example.com:8080");
    config.ignore_ssl = Some(true);

    assert!(validate_proxy_config(&config).is_ok());
    assert!(create_proxy_from_config(&config).is_ok());
}

#[test]
fn test_proxy_config_ssl_defaults() {
    // Test with no SSL settings (should use None defaults)
    let config = create_test_proxy_config("https://proxy.example.com:8080");

    assert_eq!(config.ignore_ssl, None);

    assert!(validate_proxy_config(&config).is_ok());
    assert!(create_proxy_from_config(&config).is_ok());
}

#[test]
fn test_download_item_with_ssl_proxy() {
    // Test that DownloadItem can be created with SSL proxy configuration
    let mut proxy_config = create_test_proxy_config("https://proxy.example.com:8080");
    proxy_config.ignore_ssl = Some(true);

    let download_item = DownloadItem {
        url: "https://example.com/file.zip".to_string(),
        save_path: "downloads/file.zip".to_string(),
        proxy: Some(proxy_config),
        sha256: None,
        size: None,
        model_id: None,
    };

    assert!(download_item.proxy.is_some());
    let proxy = download_item.proxy.unwrap();
    assert_eq!(proxy.ignore_ssl, Some(true));
}

#[test]
fn test_client_creation_with_ssl_settings() {
    // Test client creation with SSL settings
    let mut proxy_config = create_test_proxy_config("https://proxy.example.com:8080");
    proxy_config.ignore_ssl = Some(true);

    let download_item = DownloadItem {
        url: "https://example.com/file.zip".to_string(),
        save_path: "downloads/file.zip".to_string(),
        proxy: Some(proxy_config),
        sha256: None,
        size: None,
        model_id: None,
    };

    let header_map = HeaderMap::new();
    let result = _get_client_for_item(&download_item, &header_map);

    // Should create client successfully even with SSL settings
    assert!(result.is_ok());
}

#[test]
fn test_proxy_config_with_http_and_ssl_settings() {
    // Test that SSL settings work with HTTP proxy (though not typically used)
    let mut config = create_test_proxy_config("http://proxy.example.com:8080");
    config.ignore_ssl = Some(true);

    assert!(validate_proxy_config(&config).is_ok());
    assert!(create_proxy_from_config(&config).is_ok());
}

#[test]
fn test_proxy_config_with_socks_and_ssl_settings() {
    // Test that SSL settings work with SOCKS proxy
    let mut config = create_test_proxy_config("socks5://proxy.example.com:1080");
    config.ignore_ssl = Some(false);

    assert!(validate_proxy_config(&config).is_ok());

    // SOCKS proxies are not supported by reqwest::Proxy::all()
    // This test should expect an error for SOCKS proxies
    let result = create_proxy_from_config(&config);
    assert!(result.is_err());

    // Test with HTTP proxy instead which is supported
    let mut http_config = create_test_proxy_config("http://proxy.example.com:8080");
    http_config.ignore_ssl = Some(false);
    assert!(validate_proxy_config(&http_config).is_ok());
    assert!(create_proxy_from_config(&http_config).is_ok());
}

#[test]
fn test_download_item_creation() {
    let item = DownloadItem {
        url: "https://example.com/file.tar.gz".to_string(),
        save_path: "models/test.tar.gz".to_string(),
        proxy: None,
        sha256: None,
        size: None,
        model_id: None,
    };

    assert_eq!(item.url, "https://example.com/file.tar.gz");
    assert_eq!(item.save_path, "models/test.tar.gz");
}

#[test]
fn test_download_event_creation() {
    let event = DownloadEvent {
        transferred: 1024,
        total: 2048,
    };

    assert_eq!(event.transferred, 1024);
    assert_eq!(event.total, 2048);
}

#[test]
fn test_err_to_string() {
    let error = "Test error";
    let result = err_to_string(error);
    assert_eq!(result, "Error: Test error");
}

#[tokio::test]
async fn resumes_an_interrupted_download_from_the_persisted_offset() {
    let (bytes, requests, save_path) =
        run_interrupted_download_test(TestRangeBehavior::Supported).await;

    assert_eq!(bytes, b"abcdef");
    assert_eq!(requests, 2);
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn restarts_an_interrupted_download_when_ranges_are_unsupported() {
    let (bytes, requests, save_path) =
        run_interrupted_download_test(TestRangeBehavior::Unsupported).await;

    assert_eq!(bytes, b"abcdef");
    assert_eq!(requests, 3);
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn restarts_an_interrupted_download_when_content_range_is_mismatched() {
    let (bytes, requests, save_path) =
        run_interrupted_download_test(TestRangeBehavior::Mismatched).await;

    assert_eq!(bytes, b"abcdef");
    assert_eq!(requests, 3);
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn downloads_model_fixture_and_enforces_size_and_hash_contract() {
    let (url, server) = spawn_model_contract_server().await;
    let save_path = test_download_path("tiny-model.gguf");
    let item = DownloadItem {
        url,
        save_path: save_path.to_string_lossy().into_owned(),
        proxy: None,
        sha256: Some(
            "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721".to_string(),
        ),
        size: Some(6),
        model_id: Some("fixture/tiny-model".to_string()),
    };
    let app = mock_app();

    download_single_file_for_test(app.handle().clone(), &item, &save_path, 6)
        .await
        .unwrap();
    validate_downloaded_file_for_test(&item, &save_path, app.handle())
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), b"abcdef");

    let mut wrong_contract = item.clone();
    wrong_contract.sha256 = Some("0".repeat(64));
    assert!(
        validate_downloaded_file_for_test(&wrong_contract, &save_path, app.handle())
            .await
            .unwrap_err()
            .contains("Hash verification failed")
    );

    server.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[test]
fn test_convert_headers_valid() {
    let mut headers = HashMap::new();
    headers.insert("Content-Type".to_string(), "application/json".to_string());
    headers.insert("Authorization".to_string(), "Bearer token123".to_string());

    let result = _convert_headers(&headers);
    assert!(result.is_ok());

    let header_map = result.unwrap();
    assert_eq!(header_map.len(), 2);
    assert_eq!(header_map.get("Content-Type").unwrap(), "application/json");
    assert_eq!(header_map.get("Authorization").unwrap(), "Bearer token123");
}

#[test]
fn test_convert_headers_invalid_header_name() {
    let mut headers = HashMap::new();
    headers.insert("Invalid\nHeader".to_string(), "value".to_string());

    let result = _convert_headers(&headers);
    assert!(result.is_err());
}

#[test]
fn test_convert_headers_invalid_header_value() {
    let mut headers = HashMap::new();
    headers.insert("Content-Type".to_string(), "invalid\nvalue".to_string());

    let result = _convert_headers(&headers);
    assert!(result.is_err());
}

#[test]
fn test_download_manager_state_default() {
    let state = DownloadManagerState::default();
    assert!(state.cancel_tokens.is_empty());
}

#[test]
fn test_download_event_serialization() {
    let event = DownloadEvent {
        transferred: 512,
        total: 1024,
    };

    let json = serde_json::to_string(&event).unwrap();
    assert!(json.contains("\"transferred\":512"));
    assert!(json.contains("\"total\":1024"));
}

#[test]
fn test_download_item_deserialization() {
    let json = r#"{"url":"https://example.com/file.zip","save_path":"downloads/file.zip"}"#;
    let item: DownloadItem = serde_json::from_str(json).unwrap();

    assert_eq!(item.url, "https://example.com/file.zip");
    assert_eq!(item.save_path, "downloads/file.zip");
}
