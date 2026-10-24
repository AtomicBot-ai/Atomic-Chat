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

/// First request: three bytes, then a body that never ends — a stream with no
/// next chunk to wake the downloader. Ranged requests get the rest.
async fn spawn_stalling_download_server(
) -> (String, tokio::task::JoinHandle<Result<(), hyper::Error>>) {
    let request_count = Arc::new(AtomicUsize::new(0));
    let make_service = make_service_fn(move |_| {
        let request_count = request_count.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                let request_count = request_count.clone();
                async move {
                    let first = request_count.fetch_add(1, Ordering::SeqCst) == 0;
                    let response = if first {
                        let (mut sender, body) = Body::channel();
                        tokio::spawn(async move {
                            sender.send_data(Bytes::from_static(b"abc")).await.unwrap();
                            std::future::pending::<()>().await;
                            drop(sender);
                        });
                        Response::builder()
                            .status(StatusCode::OK)
                            .header(CONTENT_LENGTH, "6")
                            .body(body)
                            .unwrap()
                    } else if request.headers().get(RANGE).is_some() {
                        Response::builder()
                            .status(StatusCode::PARTIAL_CONTENT)
                            .header(CONTENT_RANGE, "bytes 3-5/6")
                            .body(Body::from("def"))
                            .unwrap()
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
    (format!("http://{address}/model.gguf"), tokio::spawn(server))
}

/// Field log, 2026-09-21: pause and resume in the same second on a slow link.
/// The paused stream only noticed its cancellation at the next chunk, eight
/// seconds on, so two invocations had one `.tmp` open; the file ended up the
/// right size with the wrong hash.
#[tokio::test]
async fn a_resume_waits_for_the_cancelled_writer_and_cancellation_does_not_wait_for_a_chunk() {
    let (url, server) = spawn_stalling_download_server().await;
    let save_path = test_download_path("model.gguf");
    let tmp_path = sidecar_path(&save_path, "tmp");
    let item = DownloadItem {
        url,
        save_path: save_path.to_string_lossy().into_owned(),
        proxy: None,
        sha256: None,
        size: Some(6),
        model_id: Some("test/model".to_string()),
        resume_key: None,
    };
    let app = mock_app();

    let paused_token = CancellationToken::new();
    let paused = tokio::spawn({
        let (app, item, save_path, token) = (
            app.handle().clone(),
            item.clone(),
            save_path.clone(),
            paused_token.clone(),
        );
        async move {
            download_single_file_with_token_for_test(app, &item, &save_path, 6, true, token).await
        }
    });
    // The stalled writer has its file open; nothing of "abc" is flushed yet.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !tmp_path.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("first download never opened its partial");

    let resumed = tokio::spawn({
        let (app, item, save_path) = (app.handle().clone(), item.clone(), save_path.clone());
        async move {
            download_single_file_with_token_for_test(
                app,
                &item,
                &save_path,
                6,
                true,
                CancellationToken::new(),
            )
            .await
        }
    });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(
        !resumed.is_finished() && !save_path.exists(),
        "the resume wrote while the paused download still held the file"
    );

    paused_token.cancel();
    let paused_result = tokio::time::timeout(std::time::Duration::from_secs(5), paused)
        .await
        .expect("cancellation waited for a chunk that never came")
        .unwrap();
    assert_eq!(paused_result.unwrap_err(), "Download cancelled");

    tokio::time::timeout(std::time::Duration::from_secs(5), resumed)
        .await
        .expect("the resume never got the file")
        .unwrap()
        .unwrap();
    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), b"abcdef");

    server.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
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
        resume_key: None,
    }
}

#[tokio::test]
async fn preflight_uses_catalog_size_without_a_head_request() {
    let (url, request_count, server) = spawn_preflight_head_server(0, StatusCode::OK).await;
    let item = preflight_test_item(url, Some(6));
    let client = reqwest::Client::new();
    let size = preflight_file_size(&client, &item, &CancellationToken::new(), None)
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

    let error = preflight_file_size(&client, &item, &cancel_token, None)
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
    let size = preflight_file_size(&client, &item, &CancellationToken::new(), None)
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
    let size = preflight_file_size(&client, &item, &CancellationToken::new(), None)
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
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 42\r\nconnection: close\r\n\r\n")
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
    let size = preflight_file_size(&client, &item, &CancellationToken::new(), None)
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
        resume_key: None,
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
    let saved = tokio::fs::read(data_dir.join(&item.save_path))
        .await
        .unwrap();
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
    let size = preflight_file_size(&client, &item, &CancellationToken::new(), None)
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
        resume_key: None,
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
        resume_key: None,
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
        resume_key: None,
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
        resume_key: None,
    };

    assert_eq!(item.url, "https://example.com/file.tar.gz");
    assert_eq!(item.save_path, "models/test.tar.gz");
}

#[test]
fn test_download_event_creation() {
    let event = DownloadEvent {
        transferred: 1024,
        total: 2048,
        stage: None,
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
        resume_key: None,
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
        stage: None,
    };

    let json = serde_json::to_string(&event).unwrap();
    assert!(json.contains("\"transferred\":512"));
    assert!(json.contains("\"total\":1024"));
    // A plain progress tick must not carry a stage key at all, so the frontend
    // can tell "bytes moved" from "status changed" by presence alone.
    assert!(!json.contains("stage"));
}

#[test]
fn test_download_event_stage_serialization() {
    let event = DownloadEvent {
        transferred: 0,
        total: 0,
        stage: Some(DownloadStage {
            kind: DownloadStage::RETRYING,
            attempt: 2,
            max_attempts: 5,
        }),
    };

    let json = serde_json::to_string(&event).unwrap();
    assert!(json.contains("\"kind\":\"retrying\""));
    assert!(json.contains("\"attempt\":2"));
    // camelCase, because the payload is consumed directly by the webview.
    assert!(json.contains("\"maxAttempts\":5"));
}

#[test]
fn test_download_item_deserialization() {
    let json = r#"{"url":"https://example.com/file.zip","save_path":"downloads/file.zip"}"#;
    let item: DownloadItem = serde_json::from_str(json).unwrap();

    assert_eq!(item.url, "https://example.com/file.zip");
    assert_eq!(item.save_path, "downloads/file.zip");
}

/// A task that is stopped because a newer download claimed its id must be
/// distinguishable from one the user cancelled: only the latter's files are
/// the caller's to touch.
#[test]
fn superseded_task_is_marked_and_cancelled() {
    let losing = DownloadTask::new();
    let winning = DownloadTask::new();

    losing.supersede();

    assert!(losing.cancel_token.is_cancelled());
    assert!(losing.was_superseded());
    assert!(!winning.was_superseded());
}

/// The end-of-run cleanup drops its registration only when the map still holds
/// the same task — otherwise it would deregister the successor and leave that
/// download uncancellable.
#[test]
fn a_task_recognises_itself_but_not_a_same_id_successor() {
    let first = DownloadTask::new();
    let successor = DownloadTask::new();

    assert!(first.is_same_task(&first.clone()));
    assert!(!first.is_same_task(&successor));
}

#[test]
fn a_plain_cancellation_is_not_a_supersede() {
    let task = DownloadTask::new();
    task.cancel_token.cancel();

    assert!(task.cancel_token.is_cancelled());
    assert!(!task.was_superseded());
}

// ===== ATO — #290: a refused connection has to be visible =====

/// A port nothing listens on, so a connect attempt is refused immediately.
/// Bound and dropped so the OS has genuinely handed it out and then freed it.
async fn refused_port() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

#[tokio::test]
async fn preflight_reports_every_retry_so_the_ui_is_not_left_silent() {
    // Before this, both retry ladders ran for ~31s each emitting nothing, so a
    // download against an unreachable host was indistinguishable from one that
    // had not started. The reporter is what the download card reads.
    let (url, _request_count, server) =
        spawn_preflight_head_server(2, StatusCode::INTERNAL_SERVER_ERROR).await;
    let item = preflight_test_item(url, None);
    let client = reqwest::Client::new();

    let stages = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = stages.clone();
    let reporter = StageReporter::from_fn(move |stage| {
        recorded
            .lock()
            .unwrap()
            .push((stage.kind, stage.attempt, stage.max_attempts));
    });

    let size = preflight_file_size(&client, &item, &CancellationToken::new(), Some(&reporter))
        .await
        .unwrap();
    assert_eq!(size, 42);

    let stages = stages.lock().unwrap().clone();
    assert_eq!(
        stages,
        vec![
            (DownloadStage::CONNECTING, 0, 5),
            (DownloadStage::RETRYING, 1, 5),
            (DownloadStage::RETRYING, 2, 5),
        ],
        "the ladder must announce the attempt it is on, not go quiet"
    );

    server.abort();
}

#[tokio::test]
async fn proxy_test_reports_a_refused_proxy_rather_than_failing_silently() {
    // The exact shape of https://github.com/AtomicBot-ai/Atomic-Chat/issues/290:
    // a proxy address that nothing is listening on. `validate_proxy_config`
    // passes it happily — only an actual connection attempt can tell.
    let port = refused_port().await;
    let result = super::commands::test_proxy_connection(ProxyConfig {
        url: format!("http://127.0.0.1:{port}"),
        username: None,
        password: None,
        no_proxy: None,
        ignore_ssl: None,
    })
    .await
    .unwrap();

    assert!(!result.ok);
    assert_eq!(result.kind, "unreachable");
    assert!(!result.detail.is_empty());
}

#[tokio::test]
async fn proxy_test_rejects_a_malformed_url_without_touching_the_network() {
    let result = super::commands::test_proxy_connection(ProxyConfig {
        url: "not a url".to_string(),
        username: None,
        password: None,
        no_proxy: None,
        ignore_ssl: None,
    })
    .await
    .unwrap();

    assert!(!result.ok);
    assert_eq!(result.kind, "invalid_config");
}

#[tokio::test]
async fn proxy_test_says_so_when_no_proxy_would_skip_the_proxy_entirely() {
    // Otherwise the test would pass for the wrong reason: the request never
    // went through the proxy at all, so it proves nothing about it.
    let port = refused_port().await;
    let result = super::commands::test_proxy_connection(ProxyConfig {
        url: format!("http://127.0.0.1:{port}"),
        username: None,
        password: None,
        no_proxy: Some(vec!["huggingface.co".to_string()]),
        ignore_ssl: None,
    })
    .await
    .unwrap();

    assert_eq!(result.kind, "bypassed");
}

// ===== Stalls, slow responses and multi-connection downloads =====
//
// Field feedback, 2026-09-29: "2 GB shows an hour, no progress, only a restart
// helps". A dead connection hung the body read forever, and one connection per
// file ran far below the link on Hugging Face's CDN.

use super::helpers::TransferTuning;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

fn record_download_events(
    app: &tauri::App<tauri::test::MockRuntime>,
) -> Arc<std::sync::Mutex<Vec<String>>> {
    use tauri::Listener;
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = events.clone();
    app.listen("test-download-progress", move |event| {
        sink.lock().unwrap().push(event.payload().to_string());
    });
    events
}

fn has_stage(events: &Arc<std::sync::Mutex<Vec<String>>>, kind: &str) -> bool {
    let needle = format!("\"kind\":\"{kind}\"");
    events
        .lock()
        .unwrap()
        .iter()
        .any(|event| event.contains(&needle))
}

fn test_item(url: String, save_path: &std::path::Path, size: u64) -> DownloadItem {
    DownloadItem {
        url,
        save_path: save_path.to_string_lossy().into_owned(),
        proxy: None,
        sha256: None,
        size: Some(size),
        model_id: Some("test/model".to_string()),
        resume_key: None,
    }
}

#[tokio::test]
async fn a_connection_that_goes_quiet_is_reopened_from_the_durable_offset() {
    // The first response sends "abc" and then nothing, with the socket open.
    let (url, server) = spawn_stalling_download_server().await;
    let save_path = test_download_path("model.gguf");
    let item = test_item(url, &save_path, 6);
    let app = mock_app();
    let events = record_download_events(&app);
    let tuning = TransferTuning {
        idle_timeout: Duration::from_millis(300),
        stall_notice: Duration::from_millis(100),
        ..TransferTuning::default()
    };

    tokio::time::timeout(
        Duration::from_secs(5),
        download_single_file_with_tuning_for_test(
            app.handle().clone(),
            &item,
            &save_path,
            6,
            false,
            CancellationToken::new(),
            tuning,
        ),
    )
    .await
    .expect("the stalled body was never given up on")
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), b"abcdef");
    assert!(
        has_stage(&events, "stalled"),
        "the panel was never told: {:?}",
        events.lock().unwrap()
    );
    assert!(
        has_stage(&events, "retrying"),
        "the reconnect ran silently: {:?}",
        events.lock().unwrap()
    );

    server.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn a_server_that_never_answers_is_retried_instead_of_waited_on() {
    let request_count = Arc::new(AtomicUsize::new(0));
    let service_count = request_count.clone();
    let make_service = make_service_fn(move |_| {
        let service_count = service_count.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |_request: Request<Body>| {
                let first = service_count.fetch_add(1, Ordering::SeqCst) == 0;
                async move {
                    if first {
                        std::future::pending::<()>().await;
                    }
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(StatusCode::OK)
                            .body(Body::from("abcdef"))
                            .unwrap(),
                    )
                }
            }))
        }
    });
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(Server::from_tcp(listener).unwrap().serve(make_service));

    let save_path = test_download_path("model.gguf");
    let item = test_item(format!("http://{address}/model.gguf"), &save_path, 6);
    let tuning = TransferTuning {
        response_timeout: Duration::from_millis(200),
        ..TransferTuning::default()
    };
    tokio::time::timeout(
        Duration::from_secs(5),
        download_single_file_with_tuning_for_test(
            mock_app().handle().clone(),
            &item,
            &save_path,
            6,
            false,
            CancellationToken::new(),
            tuning,
        ),
    )
    .await
    .expect("waited on a response that never came")
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), b"abcdef");
    assert_eq!(request_count.load(Ordering::SeqCst), 2);
    server.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

/// A CDN in miniature: serves `body`, honouring `bytes=a-b` / `bytes=a-`
/// ranges unless told not to, and records where each request started.
struct RangeServer {
    url: String,
    starts: Arc<std::sync::Mutex<Vec<Option<u64>>>>,
    /// Bytes of stalled responses that were actually sent.
    served: Arc<AtomicU64>,
    /// This many upcoming ranged responses send half of their bytes and then
    /// go quiet with the socket open.
    stall_next: Arc<AtomicUsize>,
    handle: tokio::task::JoinHandle<Result<(), hyper::Error>>,
}

fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    let start: u64 = start.parse().ok()?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().ok()?.min(size - 1)
    };
    (start <= end).then_some((start, end))
}

async fn spawn_range_server(body: Arc<Vec<u8>>, honour_ranges: bool) -> RangeServer {
    let starts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let served = Arc::new(AtomicU64::new(0));
    let stall_next = Arc::new(AtomicUsize::new(0));
    let state = (starts.clone(), served.clone(), stall_next.clone(), body);
    let make_service = make_service_fn(move |_| {
        let state = state.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                let (starts, served, stall_next, body) = state.clone();
                async move {
                    let size = body.len() as u64;
                    let range = request
                        .headers()
                        .get(RANGE)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| parse_range(value, size));
                    starts.lock().unwrap().push(range.map(|(start, _)| start));
                    let response = match range {
                        Some((start, end)) if honour_ranges => {
                            let slice = body[start as usize..=end as usize].to_vec();
                            let builder = Response::builder()
                                .status(StatusCode::PARTIAL_CONTENT)
                                .header(CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
                                .header(CONTENT_LENGTH, slice.len().to_string());
                            let stall = stall_next
                                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                                    n.checked_sub(1)
                                })
                                .is_ok();
                            if stall {
                                let half = slice.len() / 2;
                                served.fetch_add(half as u64, Ordering::SeqCst);
                                let (mut sender, body) = Body::channel();
                                tokio::spawn(async move {
                                    let _ =
                                        sender.send_data(Bytes::from(slice[..half].to_vec())).await;
                                    std::future::pending::<()>().await;
                                    drop(sender);
                                });
                                builder.body(body).unwrap()
                            } else {
                                builder.body(Body::from(slice)).unwrap()
                            }
                        }
                        _ => Response::builder()
                            .status(StatusCode::OK)
                            .header(CONTENT_LENGTH, size.to_string())
                            .body(Body::from(body.to_vec()))
                            .unwrap(),
                    };
                    Ok::<_, Infallible>(response)
                }
            }))
        }
    });
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    RangeServer {
        url: format!("http://{address}/model.gguf"),
        starts,
        served,
        stall_next,
        handle: tokio::spawn(Server::from_tcp(listener).unwrap().serve(make_service)),
    }
}

const SEGMENTED_TEST_SIZE: usize = 256 * 1024;

fn segmented_test_body() -> Arc<Vec<u8>> {
    Arc::new(
        (0..SEGMENTED_TEST_SIZE)
            .map(|i| (i * 31 % 251) as u8)
            .collect(),
    )
}

/// Four connections over 16 KiB ranges, and timings short enough for a test.
fn segmented_test_tuning() -> TransferTuning {
    TransferTuning {
        idle_timeout: Duration::from_millis(400),
        stall_notice: Duration::from_millis(150),
        response_timeout: Duration::from_millis(400),
        progress_interval: Duration::from_millis(20),
        segmented_min_size: 64 * 1024,
        min_segment_size: 16 * 1024,
        max_connections: 4,
        persist_interval: Duration::from_millis(20),
    }
}

async fn download_segmented_for_test(
    server: &RangeServer,
    save_path: &std::path::Path,
    resume: bool,
    cancel_token: CancellationToken,
    tuning: TransferTuning,
) -> Result<std::path::PathBuf, String> {
    let item = test_item(server.url.clone(), save_path, SEGMENTED_TEST_SIZE as u64);
    download_single_file_with_tuning_for_test(
        mock_app().handle().clone(),
        &item,
        save_path,
        SEGMENTED_TEST_SIZE as u64,
        resume,
        cancel_token,
        tuning,
    )
    .await
}

fn assert_no_sidecars(save_path: &std::path::Path) {
    for ext in ["tmp", "url", "parts", "parts.new"] {
        let sidecar = sidecar_path(save_path, ext);
        assert!(!sidecar.exists(), "{} was left behind", sidecar.display());
    }
}

#[tokio::test]
async fn a_large_file_comes_over_several_ranged_connections() {
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), true).await;
    let save_path = test_download_path("model.gguf");

    download_segmented_for_test(
        &server,
        &save_path,
        false,
        CancellationToken::new(),
        segmented_test_tuning(),
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
    let starts = server.starts.lock().unwrap().clone();
    assert!(
        starts.iter().all(Option::is_some),
        "a request was not ranged: {starts:?}"
    );
    assert!(
        starts.len() >= 4,
        "only {} connections were opened",
        starts.len()
    );
    assert_no_sidecars(&save_path);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn a_server_that_ignores_ranges_gets_one_plain_download() {
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), false).await;
    let save_path = test_download_path("model.gguf");

    download_segmented_for_test(
        &server,
        &save_path,
        false,
        CancellationToken::new(),
        segmented_test_tuning(),
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
    // The ranged probe got a 200, and the file then came over one plain GET.
    let starts = server.starts.lock().unwrap().clone();
    assert_eq!(starts, vec![Some(0), None]);
    assert_no_sidecars(&save_path);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn a_saved_segment_map_resumes_only_the_missing_bytes() {
    // Both legacy layouts must reuse the same already-written ranges.
    for keep_url_marker in [true, false] {
        let body = segmented_test_body();
        let server = spawn_range_server(body.clone(), true).await;
        let save_path = test_download_path("model.gguf");
        tokio::fs::create_dir_all(save_path.parent().unwrap())
            .await
            .unwrap();

        // The first half is on disk in a full-size partial, as a cancel leaves it.
        let half = SEGMENTED_TEST_SIZE / 2;
        let mut partial = body[..half].to_vec();
        partial.resize(SEGMENTED_TEST_SIZE, 0);
        tokio::fs::write(sidecar_path(&save_path, "tmp"), &partial)
            .await
            .unwrap();
        if keep_url_marker {
            tokio::fs::write(sidecar_path(&save_path, "url"), &server.url)
                .await
                .unwrap();
        }
        let map = serde_json::json!({
            "version": 1,
            "url": server.url,
            "size": SEGMENTED_TEST_SIZE,
            "segments": [[0, half, half], [half, half, SEGMENTED_TEST_SIZE]],
        });
        tokio::fs::write(sidecar_path(&save_path, "parts"), map.to_string())
            .await
            .unwrap();

        download_segmented_for_test(
            &server,
            &save_path,
            true,
            CancellationToken::new(),
            segmented_test_tuning(),
        )
        .await
        .unwrap();

        assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
        let starts = server.starts.lock().unwrap().clone();
        assert!(
            starts
                .iter()
                .all(|start| start.is_some_and(|start| start >= half as u64)),
            "bytes already on disk were fetched again: {starts:?}"
        );
        assert_no_sidecars(&save_path);

        server.handle.abort();
        let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
    }
}

#[tokio::test]
async fn a_single_stream_partial_is_taken_over_without_refetching_it() {
    // A pause from a build that downloaded over one connection.
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), true).await;
    let save_path = test_download_path("model.gguf");
    tokio::fs::create_dir_all(save_path.parent().unwrap())
        .await
        .unwrap();
    let prefix = 100 * 1024;
    tokio::fs::write(sidecar_path(&save_path, "tmp"), &body[..prefix])
        .await
        .unwrap();
    tokio::fs::write(sidecar_path(&save_path, "url"), &server.url)
        .await
        .unwrap();

    download_segmented_for_test(
        &server,
        &save_path,
        true,
        CancellationToken::new(),
        segmented_test_tuning(),
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
    let starts = server.starts.lock().unwrap().clone();
    assert!(
        starts
            .iter()
            .all(|start| start.is_some_and(|start| start >= prefix as u64)),
        "the partial was fetched again: {starts:?}"
    );
    assert_no_sidecars(&save_path);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn a_range_whose_connection_goes_quiet_is_reopened_where_it_stopped() {
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), true).await;
    server.stall_next.store(1, Ordering::SeqCst);
    let save_path = test_download_path("model.gguf");

    tokio::time::timeout(
        Duration::from_secs(10),
        download_segmented_for_test(
            &server,
            &save_path,
            false,
            CancellationToken::new(),
            segmented_test_tuning(),
        ),
    )
    .await
    .expect("the quiet range was never reopened")
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
    // The probe asked for 0..64 KiB and went quiet after half of it: the half
    // that came was kept, and the range was reopened right after it.
    let starts = server.starts.lock().unwrap().clone();
    assert_eq!(starts[0], Some(0));
    assert!(
        starts.contains(&Some(32 * 1024)),
        "the range restarted elsewhere: {starts:?}"
    );
    assert_no_sidecars(&save_path);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn a_cancelled_multi_connection_download_keeps_its_map_and_resumes_from_it() {
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), true).await;
    // Every connection sends half of its range and then hangs.
    server.stall_next.store(usize::MAX, Ordering::SeqCst);
    let save_path = test_download_path("model.gguf");
    let tuning = TransferTuning {
        idle_timeout: Duration::from_secs(30),
        stall_notice: Duration::from_secs(30),
        ..segmented_test_tuning()
    };

    let cancel_token = CancellationToken::new();
    let running = tokio::spawn({
        let (server_url, save_path, token, tuning) = (
            server.url.clone(),
            save_path.clone(),
            cancel_token.clone(),
            tuning.clone(),
        );
        async move {
            let item = test_item(server_url, &save_path, SEGMENTED_TEST_SIZE as u64);
            download_single_file_with_tuning_for_test(
                mock_app().handle().clone(),
                &item,
                &save_path,
                SEGMENTED_TEST_SIZE as u64,
                false,
                token,
                tuning,
            )
            .await
        }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while server.served.load(Ordering::SeqCst) < SEGMENTED_TEST_SIZE as u64 / 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the connections never delivered their first halves");
    cancel_token.cancel();
    let cancelled = tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .expect("cancellation waited on a quiet connection")
        .unwrap();
    assert_eq!(cancelled.unwrap_err(), "Download cancelled");

    let tmp_len = std::fs::metadata(sidecar_path(&save_path, "tmp"))
        .unwrap()
        .len();
    assert_eq!(
        tmp_len, SEGMENTED_TEST_SIZE as u64,
        "the partial is not full-size"
    );
    let kept = super::segmented::downloaded_bytes_on_disk(&save_path);
    assert_eq!(
        kept,
        SEGMENTED_TEST_SIZE as u64 / 2,
        "the map lost what had landed"
    );
    let map: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(sidecar_path(&save_path, "parts")).unwrap())
            .unwrap();
    let missing: Vec<(u64, u64)> = map["segments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|range| (range[1].as_u64().unwrap(), range[2].as_u64().unwrap()))
        .filter(|(written, end)| written < end)
        .collect();

    server.stall_next.store(0, Ordering::SeqCst);
    let requests_before = server.starts.lock().unwrap().len();
    download_segmented_for_test(
        &server,
        &save_path,
        true,
        CancellationToken::new(),
        segmented_test_tuning(),
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
    let resumed: Vec<u64> = server.starts.lock().unwrap()[requests_before..]
        .iter()
        .map(|start| start.expect("a resume request was not ranged"))
        .collect();
    assert!(
        resumed.iter().all(|start| missing
            .iter()
            .any(|(written, end)| start >= written && start < end)),
        "the resume fetched bytes it already had: requests at {resumed:?}, missing {missing:?}"
    );
    assert_no_sidecars(&save_path);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

// Foundry Local: links are signed and expire, so a resumed file comes from
// another URL. `resume_key` is what the partial is matched against then.

fn keyed_item(url: String, save_path: &std::path::Path, key: Option<&str>) -> DownloadItem {
    DownloadItem {
        resume_key: key.map(str::to_string),
        ..test_item(url, save_path, SEGMENTED_TEST_SIZE as u64)
    }
}

async fn download_item_for_test(
    item: &DownloadItem,
    save_path: &std::path::Path,
    resume: bool,
    cancel_token: CancellationToken,
    tuning: TransferTuning,
) -> Result<std::path::PathBuf, String> {
    download_single_file_with_tuning_for_test(
        mock_app().handle().clone(),
        item,
        save_path,
        SEGMENTED_TEST_SIZE as u64,
        resume,
        cancel_token,
        tuning,
    )
    .await
}

/// A half-done partial with its map, saved under `identity`.
async fn seed_half_partial(save_path: &std::path::Path, body: &[u8], identity: &str) -> usize {
    tokio::fs::create_dir_all(save_path.parent().unwrap())
        .await
        .unwrap();
    let half = SEGMENTED_TEST_SIZE / 2;
    let mut partial = body[..half].to_vec();
    partial.resize(SEGMENTED_TEST_SIZE, 0);
    tokio::fs::write(sidecar_path(save_path, "tmp"), &partial)
        .await
        .unwrap();
    tokio::fs::write(sidecar_path(save_path, "url"), identity)
        .await
        .unwrap();
    let map = serde_json::json!({
        "version": 1,
        "url": identity,
        "size": SEGMENTED_TEST_SIZE,
        "segments": [[0, half, half], [half, half, SEGMENTED_TEST_SIZE]],
    });
    tokio::fs::write(sidecar_path(save_path, "parts"), map.to_string())
        .await
        .unwrap();
    half
}

#[tokio::test]
async fn a_resume_key_resumes_a_segmented_partial_from_another_url() {
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), true).await;
    let save_path = test_download_path("model.onnx");
    let key = "foundry-local/qwen/model.onnx";
    let half = seed_half_partial(&save_path, &body, key).await;

    let item = keyed_item(format!("{}?sig=fresh", server.url), &save_path, Some(key));
    download_item_for_test(
        &item,
        &save_path,
        true,
        CancellationToken::new(),
        segmented_test_tuning(),
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
    let starts = server.starts.lock().unwrap().clone();
    assert!(
        starts
            .iter()
            .all(|start| start.is_some_and(|start| start >= half as u64)),
        "bytes already on disk were fetched again: {starts:?}"
    );
    assert_no_sidecars(&save_path);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn a_resume_key_resumes_a_single_stream_partial_from_another_url() {
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), true).await;
    let save_path = test_download_path("model.onnx");
    tokio::fs::create_dir_all(save_path.parent().unwrap())
        .await
        .unwrap();
    let key = "foundry-local/qwen/model.onnx";
    let prefix = 100 * 1024;
    tokio::fs::write(sidecar_path(&save_path, "tmp"), &body[..prefix])
        .await
        .unwrap();
    tokio::fs::write(sidecar_path(&save_path, "url"), key)
        .await
        .unwrap();

    let item = keyed_item(format!("{}?sig=fresh", server.url), &save_path, Some(key));
    let one_connection = TransferTuning {
        max_connections: 1,
        ..segmented_test_tuning()
    };
    download_item_for_test(
        &item,
        &save_path,
        true,
        CancellationToken::new(),
        one_connection,
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
    let starts = server.starts.lock().unwrap().clone();
    assert_eq!(
        starts,
        vec![Some(prefix as u64)],
        "the partial was fetched again"
    );
    assert_no_sidecars(&save_path);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn without_a_resume_key_a_partial_from_another_url_starts_over() {
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), true).await;
    let save_path = test_download_path("model.gguf");
    seed_half_partial(&save_path, &body, &format!("{}?sig=old", server.url)).await;

    let item = keyed_item(format!("{}?sig=new", server.url), &save_path, None);
    download_item_for_test(
        &item,
        &save_path,
        true,
        CancellationToken::new(),
        segmented_test_tuning(),
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
    let starts = server.starts.lock().unwrap().clone();
    assert!(
        starts.contains(&Some(0)),
        "a partial saved under another URL was kept: {starts:?}"
    );
    assert_no_sidecars(&save_path);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

/// The spec scenario "Докачка на следующий день": cancelled under one link,
/// resumed under a fresh one with the same key.
#[tokio::test]
async fn a_download_cancelled_under_one_link_resumes_under_a_fresh_one_with_the_same_key() {
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), true).await;
    server.stall_next.store(usize::MAX, Ordering::SeqCst);
    let save_path = test_download_path("model.onnx");
    let key = "foundry-local/qwen/model.onnx";
    let tuning = TransferTuning {
        idle_timeout: Duration::from_secs(30),
        stall_notice: Duration::from_secs(30),
        ..segmented_test_tuning()
    };

    let cancel_token = CancellationToken::new();
    let running = tokio::spawn({
        let item = keyed_item(format!("{}?sig=today", server.url), &save_path, Some(key));
        let (save_path, token, tuning) = (save_path.clone(), cancel_token.clone(), tuning.clone());
        async move { download_item_for_test(&item, &save_path, false, token, tuning).await }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while server.served.load(Ordering::SeqCst) < SEGMENTED_TEST_SIZE as u64 / 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the connections never delivered their first halves");
    cancel_token.cancel();
    let cancelled = tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .expect("cancellation waited on a quiet connection")
        .unwrap();
    assert_eq!(cancelled.unwrap_err(), "Download cancelled");
    assert_eq!(
        std::fs::read_to_string(sidecar_path(&save_path, "url")).unwrap(),
        key,
        "the partial is not saved under its key"
    );

    server.stall_next.store(0, Ordering::SeqCst);
    let requests_before = server.starts.lock().unwrap().len();
    let item = keyed_item(
        format!("{}?sig=tomorrow", server.url),
        &save_path,
        Some(key),
    );
    download_item_for_test(
        &item,
        &save_path,
        true,
        CancellationToken::new(),
        segmented_test_tuning(),
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
    let resumed = server.starts.lock().unwrap()[requests_before..].to_vec();
    assert!(
        !resumed.contains(&Some(0)),
        "the resume under a fresh link started over: {resumed:?}"
    );
    assert_no_sidecars(&save_path);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[test]
fn a_download_item_without_a_resume_key_still_deserializes() {
    let item: DownloadItem =
        serde_json::from_str(r#"{"url":"https://h/m.gguf","save_path":"/m.gguf"}"#).unwrap();
    assert_eq!(item.resume_key, None);
    let keyed: DownloadItem = serde_json::from_str(
        r#"{"url":"https://h/m.onnx?sig=1","save_path":"/m.onnx","resume_key":"foundry-local/v/m.onnx"}"#,
    )
    .unwrap();
    assert_eq!(keyed.resume_key.as_deref(), Some("foundry-local/v/m.onnx"));
}

// Connection recovery must outlive the old five-retry limit without turning
// HTTP refusals, manual pauses, or corrupt files into endless background work.
#[test]
fn connection_retry_intervals_cap_at_sixty_four_seconds() {
    let seconds: Vec<_> = (0..10).map(|n| retry_interval(n).as_secs()).collect();
    assert_eq!(seconds, vec![1, 2, 4, 8, 16, 32, 64, 64, 64, 64]);
    assert_eq!(retry_interval(u32::MAX).as_secs(), 64);
    assert!(should_retry_download("[network] DNS failure", u32::MAX));
    for error in [
        "HTTP status 401",
        "HTTP status 403",
        "HTTP status 429",
        "HTTP status 503",
        "[disk_full] no space",
        "SHA256 mismatch",
        "invalid certificate",
        "Download cancelled",
    ] {
        assert!(!should_retry_download(error, MAX_STREAM_RETRIES), "{error}");
    }
}

#[tokio::test]
async fn connection_retry_get_stops_immediately_on_manual_cancellation() {
    let port = refused_port().await;
    let token = CancellationToken::new();
    let stop = token.clone();
    let attempts = Arc::new(AtomicUsize::new(0));
    let seen = attempts.clone();
    let reporter = StageReporter::from_fn(move |stage| {
        if stage.kind == DownloadStage::RETRYING {
            assert_eq!(stage.max_attempts, 0);
            seen.fetch_add(1, Ordering::SeqCst);
            if stage.attempt == 9 {
                stop.cancel();
            }
        }
    });
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        request_download_response_with_retry(
            &reqwest::Client::new(),
            &format!("http://127.0.0.1:{port}/model"),
            0,
            None,
            6,
            Duration::from_secs(1),
            &token,
            Some(&reporter),
        ),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(result.to_string().contains("cancelled"));
    assert_eq!(attempts.load(Ordering::SeqCst), 9);
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert_eq!(attempts.load(Ordering::SeqCst), 9);
}

#[tokio::test]
async fn connection_retry_http_refusals_remain_bounded() {
    for status in [
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::NOT_FOUND,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::INTERNAL_SERVER_ERROR,
        StatusCode::SERVICE_UNAVAILABLE,
    ] {
        let (url, count, server) = spawn_preflight_head_server(usize::MAX, status).await;
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            request_download_response_with_retry(
                &reqwest::Client::new(),
                &url,
                0,
                None,
                6,
                Duration::from_secs(1),
                &CancellationToken::new(),
                None,
            ),
        )
        .await
        .unwrap();
        assert!(result.is_err());
        assert_eq!(
            count.load(Ordering::SeqCst),
            if status.as_u16() < 429 { 1 } else { 6 }
        );
        server.abort();
    }
}

/// Two interrupted responses separated by eight dropped connections each.
/// The body is identical for plain and Range requests; only transport breaks.
async fn spawn_connection_retry_body_server(
    body: Arc<Vec<u8>>,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let Ok(len) = socket.read(&mut buffer).await else {
                    break;
                };
                if len == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..len]);
                if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") || request.len() > 8192 {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&request).to_ascii_lowercase();
            let n = seen.fetch_add(1, Ordering::SeqCst);
            if (1..=8).contains(&n) || (10..=17).contains(&n) {
                continue;
            }
            let range = request
                .lines()
                .find_map(|line| line.strip_prefix("range:").map(str::trim));
            let (start, end) = range
                .and_then(|s| parse_range(s.trim(), body.len() as u64))
                .unwrap_or((0, body.len() as u64 - 1));
            let payload = &body[start as usize..=end as usize];
            let range_header = if range.is_some() {
                format!("Content-Range: bytes {start}-{end}/{}\r\n", body.len())
            } else {
                String::new()
            };
            let status = if range.is_some() {
                "206 Partial Content"
            } else {
                "200 OK"
            };
            let header = format!("HTTP/1.1 {status}\r\n{range_header}Content-Length: {}\r\nConnection: close\r\n\r\n", payload.len());
            let _ = socket.write_all(header.as_bytes()).await;
            let sent = if n == 0 || n == 9 { 3 } else { payload.len() };
            let _ = socket.write_all(&payload[..sent]).await;
            if n == 0 || n == 9 {
                // Let the client consume this chunk before the deliberate EOF;
                // otherwise a truncated body can be rejected before yielding bytes.
                let _ = socket.flush().await;
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    });
    (format!("http://{address}/model.gguf"), count, handle)
}

#[tokio::test]
async fn connection_retry_resumes_plain_and_segmented_bodies_and_resets_on_bytes() {
    for segmented in [false, true] {
        let body = Arc::new((0..128).collect::<Vec<u8>>());
        let (url, count, server) = spawn_connection_retry_body_server(body.clone()).await;
        let save_path = test_download_path("model.gguf");
        let neighbour = save_path.with_file_name("finished-neighbour.gguf");
        tokio::fs::create_dir_all(save_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&neighbour, b"keep finished model")
            .await
            .unwrap();
        let item = test_item(url, &save_path, body.len() as u64);
        let app = mock_app();
        let events = record_download_events(&app);
        let tuning = TransferTuning {
            segmented_min_size: if segmented { 1 } else { u64::MAX },
            min_segment_size: 128,
            max_connections: 2,
            response_timeout: Duration::from_millis(500),
            ..TransferTuning::default()
        };
        tokio::time::timeout(
            Duration::from_secs(5),
            download_single_file_with_tuning_for_test(
                app.handle().clone(),
                &item,
                &save_path,
                body.len() as u64,
                false,
                CancellationToken::new(),
                tuning,
            ),
        )
        .await
        .expect("connection retries did not recover")
        .unwrap();
        assert!(count.load(Ordering::SeqCst) >= 19);
        assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
        assert_eq!(
            tokio::fs::read(&neighbour).await.unwrap(),
            b"keep finished model"
        );
        let attempts: Vec<_> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| {
                let event: serde_json::Value = serde_json::from_str(event).unwrap();
                let stage = event.get("stage")?;
                (stage["kind"] == "retrying").then(|| {
                    assert_eq!(stage["maxAttempts"], 0);
                    stage["attempt"].as_u64().unwrap()
                })
            })
            .collect();
        let peak = attempts
            .iter()
            .position(|n| *n >= 8)
            .expect("stopped at five retries");
        assert!(
            attempts[peak + 1..].contains(&1),
            "bytes must reset the ladder (segmented={segmented}): {attempts:?}"
        );
        assert_no_sidecars(&save_path);
        server.abort();
        let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
    }
}

#[tokio::test]
async fn connection_retry_header_wait_can_be_cancelled_without_waiting_for_timeout() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let token = CancellationToken::new();
    let stop = token.clone();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_millis(25)).await;
        stop.cancel();
        // Keep the socket open: only cancellation can end the header wait.
        std::future::pending::<()>().await;
        drop(socket);
    });
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        request_download_response_cancellable(
            &reqwest::Client::new(),
            &format!("http://{address}/model"),
            3,
            None,
            128,
            Duration::from_secs(30),
            &token,
        ),
    )
    .await
    .expect("manual pause waited for the network timeout")
    .unwrap_err();
    assert!(result.to_string().contains("cancelled"));
    server.abort();
}

#[tokio::test]
async fn resume_reuses_completed_files_without_requests_or_payload_changes() {
    let (url, count, server) =
        spawn_preflight_head_server(usize::MAX, StatusCode::UNAUTHORIZED).await;
    let save_path = test_download_path("already-complete.gguf");
    tokio::fs::create_dir_all(save_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&save_path, b"abcdef").await.unwrap();
    tokio::fs::write(sidecar_path(&save_path, "tmp"), b"old partial")
        .await
        .unwrap();
    let item = test_item(url, &save_path, 6);
    let returned = download_single_file_with_tuning_for_test(
        mock_app().handle().clone(),
        &item,
        &save_path,
        6,
        true,
        CancellationToken::new(),
        TransferTuning::default(),
    )
    .await
    .unwrap();
    assert_eq!(returned, save_path);
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), b"abcdef");
    assert_eq!(
        tokio::fs::read(sidecar_path(&save_path, "tmp"))
            .await
            .unwrap(),
        b"old partial"
    );
    assert_eq!(
        reusable_completed_file_size(&save_path, 6, true)
            .await
            .unwrap(),
        Some(6)
    );
    // Accounting uses complete bytes instead of also counting its stale partial.
    assert_eq!(super::disk::remaining_bytes(10, &[6, 2]), 2);
    server.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn resume_never_overwrites_a_mismatched_or_unverified_completed_file() {
    let save_path = test_download_path("already-complete.gguf");
    tokio::fs::create_dir_all(save_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&save_path, b"abcdef").await.unwrap();
    for expected in [0, 7] {
        let result = reusable_completed_file_size(&save_path, expected, true).await;
        assert!(result.unwrap_err().contains("left unchanged"));
        assert_eq!(tokio::fs::read(&save_path).await.unwrap(), b"abcdef");
    }
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn verified_completed_download_removes_only_owned_sidecars() {
    let save_path = test_download_path("cleanup.gguf");
    tokio::fs::create_dir_all(save_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&save_path, b"abcdef").await.unwrap();
    let neighbor = save_path.parent().unwrap().join("neighbor.gguf");
    tokio::fs::write(&neighbor, b"neighbor").await.unwrap();
    let item = test_item("https://example.invalid/model.gguf".into(), &save_path, 6);
    for suffix in ["tmp", "url", "parts", "parts.new"] {
        let body = match suffix {
            "tmp" => "abc".to_string(),
            "url" => item.url.clone(),
            _ => serde_json::json!({"url": item.url, "size": 6}).to_string(),
        };
        tokio::fs::write(sidecar_path(&save_path, suffix), body)
            .await
            .unwrap();
    }
    cleanup_completed_sidecars(
        mock_app().handle(),
        &item,
        &save_path,
        6,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    for suffix in ["tmp", "url", "parts", "parts.new"] {
        assert!(!sidecar_path(&save_path, suffix).exists());
    }
    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), b"abcdef");
    assert_eq!(tokio::fs::read(&neighbor).await.unwrap(), b"neighbor");
    cleanup_completed_sidecars(
        mock_app().handle(),
        &item,
        &save_path,
        6,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn completed_cleanup_preserves_unverified_or_conflicting_recovery_files() {
    for reason in ["size", "source", "hash", "cancel", "unknown"] {
        let save_path = test_download_path(&format!("cleanup-{reason}.gguf"));
        tokio::fs::create_dir_all(save_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&save_path, b"abcdef").await.unwrap();
        tokio::fs::write(sidecar_path(&save_path, "tmp"), b"abc")
            .await
            .unwrap();
        let mut item = test_item("https://example.invalid/model.gguf".into(), &save_path, 6);
        if reason != "unknown" {
            tokio::fs::write(
                sidecar_path(&save_path, "url"),
                if reason == "source" {
                    "other"
                } else {
                    &item.url
                },
            )
            .await
            .unwrap();
        }
        if reason == "hash" {
            item.sha256 = Some("0".repeat(64));
        }
        let token = CancellationToken::new();
        if reason == "cancel" {
            token.cancel();
        }
        assert!(cleanup_completed_sidecars(
            mock_app().handle(),
            &item,
            &save_path,
            if reason == "size" { 7 } else { 6 },
            &token
        )
        .await
        .is_err());
        assert_eq!(tokio::fs::read(&save_path).await.unwrap(), b"abcdef");
        assert_eq!(
            tokio::fs::read(sidecar_path(&save_path, "tmp"))
                .await
                .unwrap(),
            b"abc"
        );
    }
}

#[tokio::test]
async fn completed_batch_cleans_reused_shards_before_reporting_success() {
    let root = tempfile::tempdir().unwrap();
    let app = mock_app();
    tauri::Manager::manage(
        &app,
        crate::test_support::TestDataRoot(root.path().to_path_buf()),
    );
    let (url, requests, server) = spawn_preflight_head_server(0, StatusCode::OK).await;
    let save_path = root.path().join("llamacpp/models/org/cleanup/model.gguf");
    tokio::fs::create_dir_all(save_path.parent().unwrap())
        .await
        .unwrap();
    let payload = vec![b'a'; 42];
    tokio::fs::write(&save_path, &payload).await.unwrap();
    tokio::fs::write(sidecar_path(&save_path, "tmp"), b"aaaaaaaaaa")
        .await
        .unwrap();
    tokio::fs::write(sidecar_path(&save_path, "url"), &url)
        .await
        .unwrap();
    tokio::fs::write(
        sidecar_path(&save_path, "parts"),
        serde_json::json!({"url":url,"size":42}).to_string(),
    )
    .await
    .unwrap();
    let mut item = test_item(url, &save_path, 42);
    item.save_path = "llamacpp/models/org/cleanup/model.gguf".into();
    _download_files_internal(
        app.handle().clone(),
        &[item],
        &HashMap::new(),
        "completed-cleanup-test",
        true,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), 0); // Known size and completed payload require no HTTP requests.
    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), payload);
    for suffix in ["tmp", "url", "parts", "parts.new"] {
        assert!(!sidecar_path(&save_path, suffix).exists());
    }
    server.abort();
}

#[tokio::test]
async fn completed_batch_validation_failure_preserves_existing_payload_and_sidecars() {
    let root = tempfile::tempdir().unwrap();
    let app = mock_app();
    tauri::Manager::manage(
        &app,
        crate::test_support::TestDataRoot(root.path().to_path_buf()),
    );
    let (url, _, server) = spawn_preflight_head_server(0, StatusCode::OK).await;
    let save_path = root.path().join("llamacpp/models/org/cleanup/model.gguf");
    tokio::fs::create_dir_all(save_path.parent().unwrap())
        .await
        .unwrap();
    let payload = vec![b'a'; 42];
    tokio::fs::write(&save_path, &payload).await.unwrap();
    tokio::fs::write(sidecar_path(&save_path, "tmp"), b"aaaaaaaaaa")
        .await
        .unwrap();
    tokio::fs::write(sidecar_path(&save_path, "url"), &url)
        .await
        .unwrap();
    let mut item = test_item(url, &save_path, 42);
    item.save_path = "llamacpp/models/org/cleanup/model.gguf".into();
    item.sha256 = Some("0".repeat(64));
    assert!(_download_files_internal(
        app.handle().clone(),
        &[item.clone()],
        &HashMap::new(),
        "completed-bad-hash-test",
        true,
        CancellationToken::new()
    )
    .await
    .is_err());
    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), payload);
    assert_eq!(
        tokio::fs::read(sidecar_path(&save_path, "tmp"))
            .await
            .unwrap(),
        b"aaaaaaaaaa"
    );
    assert!(sidecar_path(&save_path, "url").exists());
    item.sha256 = None;
    tokio::fs::write(sidecar_path(&save_path, "url"), b"different source")
        .await
        .unwrap();
    assert!(_download_files_internal(
        app.handle().clone(),
        &[item],
        &HashMap::new(),
        "completed-cleanup-failure-test",
        true,
        CancellationToken::new()
    )
    .await
    .is_err());
    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), payload);
    assert_eq!(
        tokio::fs::read(sidecar_path(&save_path, "tmp"))
            .await
            .unwrap(),
        b"aaaaaaaaaa"
    );
    assert_eq!(
        tokio::fs::read(sidecar_path(&save_path, "url"))
            .await
            .unwrap(),
        b"different source"
    );
    server.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn completed_cleanup_never_unlinks_linked_sidecars_or_their_targets() {
    let root = tempfile::tempdir().unwrap();
    let save_path = root.path().join("model.gguf");
    let neighbor = root.path().join("neighbor.gguf");
    tokio::fs::write(&save_path, b"abcdef").await.unwrap();
    tokio::fs::write(&neighbor, b"protected").await.unwrap();
    std::os::unix::fs::symlink(&neighbor, sidecar_path(&save_path, "tmp")).unwrap();
    let item = test_item("https://example.invalid/model.gguf".into(), &save_path, 6);
    tokio::fs::write(sidecar_path(&save_path, "url"), &item.url)
        .await
        .unwrap();
    assert!(cleanup_completed_sidecars(
        mock_app().handle(),
        &item,
        &save_path,
        6,
        &CancellationToken::new()
    )
    .await
    .is_err());
    assert!(sidecar_path(&save_path, "tmp").is_symlink());
    assert!(sidecar_path(&save_path, "url").exists());
    assert_eq!(tokio::fs::read(&neighbor).await.unwrap(), b"protected");
    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), b"abcdef");
}

/// A server that answers every request with `respond(request)` and records whether each request
/// carried an `Authorization` header.
async fn spawn_header_recording_server(
    respond: fn(&Request<Body>) -> Response<Body>,
) -> (
    String,
    Arc<std::sync::Mutex<Vec<bool>>>,
    tokio::task::JoinHandle<Result<(), hyper::Error>>,
) {
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let service_seen = seen.clone();
    let make_service = make_service_fn(move |_| {
        let service_seen = service_seen.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                let service_seen = service_seen.clone();
                async move {
                    service_seen
                        .lock()
                        .unwrap()
                        .push(request.headers().contains_key("authorization"));
                    Ok::<_, Infallible>(respond(&request))
                }
            }))
        }
    });
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let server = Server::from_tcp(listener).unwrap().serve(make_service);
    (format!("http://{address}"), seen, tokio::spawn(server))
}

#[tokio::test]
async fn the_hugging_face_token_does_not_follow_a_redirect_to_another_host() {
    // change add-litert-lm-runtime, spec litert-lm-models "Токен не уходит на чужой хост": Hugging
    // Face answers a `resolve` URL with a redirect to its CDN on another host. The token the app
    // hands `download_files` for a Hugging Face URL must reach Hugging Face only.
    let (cdn, cdn_seen, cdn_server) = spawn_header_recording_server(|_| {
        Response::builder()
            .status(StatusCode::OK)
            .body(Body::from("model"))
            .unwrap()
    })
    .await;
    static CDN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CDN.set(format!("{cdn}/blob")).unwrap();
    let (hub, hub_seen, hub_server) = spawn_header_recording_server(|_| {
        Response::builder()
            .status(StatusCode::FOUND)
            .header("location", CDN.get().unwrap().as_str())
            .body(Body::empty())
            .unwrap()
    })
    .await;

    let item = DownloadItem {
        url: format!("{hub}/litert-community/gemma/resolve/abc/gemma.litertlm"),
        save_path: "unused".into(),
        proxy: None,
        sha256: None,
        size: None,
        model_id: None,
        resume_key: None,
    };
    let mut headers = HashMap::new();
    headers.insert("Authorization".to_string(), "Bearer hf_secret".to_string());
    let client = build_client_for_item(&item, &_convert_headers(&headers).unwrap(), false).unwrap();

    let response = client.get(&item.url).send().await.unwrap();

    assert_eq!(response.text().await.unwrap(), "model");
    assert_eq!(*hub_seen.lock().unwrap(), vec![true], "the hub gets the token");
    assert_eq!(*cdn_seen.lock().unwrap(), vec![false], "the CDN never does");
    hub_server.abort();
    cdn_server.abort();
}
