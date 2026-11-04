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

// The catalog still says eight bytes; the publisher now serves six. No
// response should cause a fallback to a new transfer or truncate a partial.
#[tokio::test]
async fn changed_remote_artifact_fails_once_and_keeps_partial_bytes() {
    for (offset, segmented, same_identity) in [
        (0, false, true),
        (3, false, true),
        (3, true, true),
        (6, false, true),
        (3, false, false),
        (3, true, false),
    ] {
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let service = make_service_fn(move |_| {
            let count = count.clone();
            async move {
                Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                    count.fetch_add(1, Ordering::SeqCst);
                    async move {
                        let response = if let Some(range) = request.headers().get(RANGE) {
                            let from: usize = range
                                .to_str()
                                .unwrap()
                                .trim_start_matches("bytes=")
                                .split('-')
                                .next()
                                .unwrap()
                                .parse()
                                .unwrap();
                            if from >= 6 {
                                Response::builder()
                                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                                    .header(CONTENT_RANGE, "bytes */6")
                                    .body(Body::empty())
                                    .unwrap()
                            } else {
                                Response::builder()
                                    .status(StatusCode::PARTIAL_CONTENT)
                                    .header(CONTENT_RANGE, format!("bytes {from}-5/6"))
                                    .body(Body::from(&b"abcdef"[from..]))
                                    .unwrap()
                            }
                        } else {
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
        let server = tokio::spawn(Server::from_tcp(listener).unwrap().serve(service));
        let save_path = test_download_path("changed-model.gguf");
        let item = DownloadItem {
            url: format!("http://{address}/model.gguf"),
            save_path: save_path.to_string_lossy().into_owned(),
            proxy: None,
            sha256: None,
            size: Some(8),
            model_id: None,
            resume_key: None,
        };
        let partial = &b"abcdef"[..offset];
        let saved_identity = if same_identity {
            item.resume_identity()
        } else {
            "https://example.test/old.gguf"
        };
        if offset > 0 {
            tokio::fs::create_dir_all(save_path.parent().unwrap())
                .await
                .unwrap();
            tokio::fs::write(sidecar_path(&save_path, "tmp"), partial)
                .await
                .unwrap();
            tokio::fs::write(sidecar_path(&save_path, "url"), saved_identity)
                .await
                .unwrap();
            if !same_identity && segmented {
                tokio::fs::write(sidecar_path(&save_path, "parts"), "old segment map")
                    .await
                    .unwrap();
            }
        }
        let tuning = TransferTuning {
            segmented_min_size: if segmented { 1 } else { u64::MAX },
            min_segment_size: 1,
            max_connections: 2,
            ..TransferTuning::default()
        };
        let app = mock_app();
        let error = download_single_file_with_tuning_for_test(
            app.handle().clone(),
            &item,
            &save_path,
            8,
            offset > 0,
            CancellationToken::new(),
            tuning,
        )
        .await
        .unwrap_err();
        assert!(error.contains("Refresh the model catalog"), "{error}");
        assert_eq!(
            requests.load(Ordering::SeqCst),
            1,
            "offset={offset}, segmented={segmented}"
        );
        assert!(!save_path.exists());
        if offset > 0 {
            assert_eq!(
                tokio::fs::read_to_string(sidecar_path(&save_path, "url"))
                    .await
                    .unwrap(),
                saved_identity
            );
            if !same_identity && segmented {
                assert_eq!(
                    tokio::fs::read_to_string(sidecar_path(&save_path, "parts"))
                        .await
                        .unwrap(),
                    "old segment map"
                );
            }
            assert_eq!(
                tokio::fs::read(sidecar_path(&save_path, "tmp"))
                    .await
                    .unwrap(),
                partial
            );
        } else {
            assert!(!sidecar_path(&save_path, "tmp").exists());
        }
        server.abort();
        let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
    }
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
    /// This many upcoming ranged responses trickle: 256 bytes every 100 ms,
    /// never quiet long enough for the idle watchdog.
    trickle_next: Arc<AtomicUsize>,
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
    let trickle_next = Arc::new(AtomicUsize::new(0));
    let state = (
        starts.clone(),
        served.clone(),
        stall_next.clone(),
        trickle_next.clone(),
        body,
    );
    let make_service = make_service_fn(move |_| {
        let state = state.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                let (starts, served, stall_next, trickle_next, body) = state.clone();
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
                            let take = |counter: &AtomicUsize| {
                                counter
                                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                                        n.checked_sub(1)
                                    })
                                    .is_ok()
                            };
                            if take(&trickle_next) {
                                let (mut sender, body) = Body::channel();
                                tokio::spawn(async move {
                                    for piece in slice.chunks(256) {
                                        let piece = Bytes::from(piece.to_vec());
                                        if sender.send_data(piece).await.is_err() {
                                            return;
                                        }
                                        tokio::time::sleep(Duration::from_millis(100)).await;
                                    }
                                });
                                builder.body(body).unwrap()
                            } else if take(&stall_next) {
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
        trickle_next,
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
        // Off here; the slow-connection floor has a test of its own.
        slow_window_floor: 0,
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
    tokio::fs::write(sidecar_path(&save_path, "url"), &server.url)
        .await
        .unwrap();
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
    assert_eq!(
        *hub_seen.lock().unwrap(),
        vec![true],
        "the hub gets the token"
    );
    assert_eq!(*cdn_seen.lock().unwrap(), vec![false], "the CDN never does");
    hub_server.abort();
    cdn_server.abort();
}

// ===== QA 2.2.25 (NEW-04): what a resume keeps, and slow connections =====
//
// Voxtral is a model and a projector fetched as one task. The model finished
// and passed its hash, the projector was 20 MB short and stuck, the user
// paused and resumed: the model came again from byte 0 and the bar fell from
// 99% to 26%.

/// Serves `files` by path, honouring `bytes=a-` ranges, and records each
/// request as its path and range start.
async fn spawn_files_server(
    files: Vec<(&'static str, Arc<Vec<u8>>)>,
) -> (
    String,
    Arc<std::sync::Mutex<Vec<(String, Option<u64>)>>>,
    tokio::task::JoinHandle<Result<(), hyper::Error>>,
) {
    let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
    let files: Arc<HashMap<&'static str, Arc<Vec<u8>>>> = Arc::new(files.into_iter().collect());
    let state = (requests.clone(), files);
    let make_service = make_service_fn(move |_| {
        let state = state.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                let (requests, files) = state.clone();
                async move {
                    let path = request.uri().path().to_string();
                    let Some(body) = files.get(path.as_str()).cloned() else {
                        return Ok::<_, Infallible>(
                            Response::builder()
                                .status(StatusCode::NOT_FOUND)
                                .body(Body::empty())
                                .unwrap(),
                        );
                    };
                    let size = body.len() as u64;
                    let range = request
                        .headers()
                        .get(RANGE)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| parse_range(value, size));
                    requests
                        .lock()
                        .unwrap()
                        .push((path, range.map(|(start, _)| start)));
                    let response = match range {
                        Some((start, end)) => Response::builder()
                            .status(StatusCode::PARTIAL_CONTENT)
                            .header(CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
                            .body(Body::from(body[start as usize..=end as usize].to_vec()))
                            .unwrap(),
                        None => Response::builder()
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
    (
        format!("http://{address}"),
        requests,
        tokio::spawn(Server::from_tcp(listener).unwrap().serve(make_service)),
    )
}

/// `(transferred, total)` of every byte-count event on `event`; stage events
/// carry no bytes and are left out, as the extensions leave them out.
fn record_progress(
    app: &tauri::App<tauri::test::MockRuntime>,
    event: &str,
) -> Arc<std::sync::Mutex<Vec<(u64, u64)>>> {
    use tauri::Listener;
    let progress = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = progress.clone();
    app.listen(event, move |event| {
        let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
        if payload.get("stage").is_none() {
            sink.lock().unwrap().push((
                payload["transferred"].as_u64().unwrap(),
                payload["total"].as_u64().unwrap(),
            ));
        }
    });
    progress
}

fn sha256_hex(body: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(body))
}

#[tokio::test]
async fn a_finished_hf_file_is_reused_only_after_content_verification() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let bytes = b"{\"version\":1}";
    tokio::fs::write(&path, bytes).await.unwrap();
    let mut item = DownloadItem {
        url: format!(
            "https://huggingface.co/test/model/resolve/{}/config.json",
            "a".repeat(40)
        ),
        save_path: path.to_string_lossy().into_owned(),
        size: Some(bytes.len() as u64),
        sha256: None,
        proxy: None,
        model_id: None,
        resume_key: None,
    };
    let cancel = CancellationToken::new();
    assert!(
        !finished_copy_on_disk(&item, &path, bytes.len() as u64, true, &cancel)
            .await
            .unwrap()
    );
    assert_eq!(bytes_kept_on_resume(&item, &path, bytes.len() as u64), 0);
    item.sha256 = Some(sha256_hex(bytes));
    assert!(
        finished_copy_on_disk(&item, &path, bytes.len() as u64, false, &cancel)
            .await
            .unwrap()
    );
    tokio::fs::write(&path, b"{\"version\":2}").await.unwrap();
    assert!(
        !finished_copy_on_disk(&item, &path, bytes.len() as u64, true, &cancel)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn a_resumed_task_keeps_a_file_it_had_finished_and_fetches_only_the_rest() {
    let model: Arc<Vec<u8>> = Arc::new((0..48 * 1024).map(|i| (i % 253) as u8).collect());
    let mmproj: Arc<Vec<u8>> = Arc::new((0..32 * 1024).map(|i| (i % 241) as u8).collect());
    let (base, requests, server) = spawn_files_server(vec![
        ("/model.gguf", model.clone()),
        ("/mmproj.gguf", mmproj.clone()),
    ])
    .await;
    let app = mock_app();
    let model_dir = format!("llamacpp/models/test-new-04-{}", uuid::Uuid::new_v4());
    let item = |name: &str, body: &[u8]| DownloadItem {
        url: format!("{base}/{name}"),
        save_path: format!("{model_dir}/{name}"),
        proxy: None,
        sha256: Some(sha256_hex(body)),
        size: Some(body.len() as u64),
        model_id: Some("test/voxtral".to_string()),
        resume_key: None,
    };
    let items = vec![item("model.gguf", &model), item("mmproj.gguf", &mmproj)];

    // As the pause left them: the model finished and renamed into place, the
    // projector half done.
    let dir = get_jan_data_folder_path(app.handle().clone()).join(&model_dir);
    tokio::fs::create_dir_all(&dir).await.unwrap();
    tokio::fs::write(dir.join("model.gguf"), &*model)
        .await
        .unwrap();
    let mmproj_path = dir.join("mmproj.gguf");
    let half = mmproj.len() / 2;
    tokio::fs::write(sidecar_path(&mmproj_path, "tmp"), &mmproj[..half])
        .await
        .unwrap();
    tokio::fs::write(sidecar_path(&mmproj_path, "url"), &items[1].url)
        .await
        .unwrap();

    let task_id = "test-new-04-resume";
    let progress = record_progress(&app, &format!("download-{task_id}"));
    _download_files_internal(
        app.handle().clone(),
        &items,
        &HashMap::new(),
        task_id,
        true,
        CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(
        tokio::fs::read(dir.join("model.gguf")).await.unwrap(),
        *model
    );
    assert_eq!(tokio::fs::read(&mmproj_path).await.unwrap(), *mmproj);
    assert_eq!(
        *requests.lock().unwrap(),
        vec![("/mmproj.gguf".to_string(), Some(half as u64))],
        "the finished model was fetched again, or the projector from the start"
    );
    let progress = progress.lock().unwrap().clone();
    let total = (model.len() + mmproj.len()) as u64;
    assert_eq!(
        progress.first().copied(),
        Some(((model.len() + half) as u64, total)),
        "the resume did not start from everything it kept: {progress:?}"
    );
    assert!(
        progress.windows(2).all(|pair| pair[1].0 >= pair[0].0),
        "progress went backwards: {progress:?}"
    );
    assert_eq!(progress.last().copied(), Some((total, total)));

    server.abort();
    let _ = tokio::fs::remove_dir_all(&dir).await;
}

#[tokio::test]
async fn a_finished_copy_that_fails_its_hash_is_downloaded_again() {
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), true).await;
    let save_path = test_download_path("model.gguf");
    tokio::fs::create_dir_all(save_path.parent().unwrap())
        .await
        .unwrap();
    // The right size, the wrong bytes.
    tokio::fs::write(&save_path, vec![0u8; body.len()])
        .await
        .unwrap();
    let item = DownloadItem {
        sha256: Some(sha256_hex(&body)),
        ..test_item(server.url.clone(), &save_path, body.len() as u64)
    };

    download_single_file_with_token_for_test(
        mock_app().handle().clone(),
        &item,
        &save_path,
        body.len() as u64,
        true,
        CancellationToken::new(),
    )
    .await
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
    assert_eq!(*server.starts.lock().unwrap(), vec![None]);
    assert_no_sidecars(&save_path);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn without_a_hash_a_finished_copy_counts_only_on_a_resume() {
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), true).await;
    let save_path = test_download_path("model.gguf");
    tokio::fs::create_dir_all(save_path.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&save_path, &*body).await.unwrap();
    let item = test_item(server.url.clone(), &save_path, body.len() as u64);
    let run = |resume: bool| {
        download_single_file_with_token_for_test(
            mock_app().handle().clone(),
            &item,
            &save_path,
            body.len() as u64,
            resume,
            CancellationToken::new(),
        )
    };

    run(true).await.unwrap();
    assert!(
        server.starts.lock().unwrap().is_empty(),
        "a resume fetched a file that was already complete"
    );

    // A fresh download is asked to fetch, and does.
    run(false).await.unwrap();
    assert_eq!(*server.starts.lock().unwrap(), vec![None]);
    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn a_range_whose_connection_trickles_is_reopened_where_it_stopped() {
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), true).await;
    // The probe, 0..64 KiB, trickles at 2.5 KB/s. After the split its
    // connection still owns ~32 KiB: over twelve seconds at that rate.
    server.trickle_next.store(1, Ordering::SeqCst);
    let save_path = test_download_path("model.gguf");
    let tuning = TransferTuning {
        slow_window_floor: 32 * 1024,
        ..segmented_test_tuning()
    };

    tokio::time::timeout(
        Duration::from_secs(5),
        download_segmented_for_test(&server, &save_path, false, CancellationToken::new(), tuning),
    )
    .await
    .expect("a trickling connection decided when the file ended")
    .unwrap();

    assert_eq!(tokio::fs::read(&save_path).await.unwrap(), *body);
    let starts = server.starts.lock().unwrap().clone();
    assert_eq!(starts[0], Some(0));
    // Every other range starts at 32 KiB or later; this is the reopen, after
    // the bytes the trickle had brought.
    assert!(
        starts[1..]
            .iter()
            .any(|start| start.is_some_and(|start| start > 0 && start < 32 * 1024)),
        "the slow range was not reopened where it stopped: {starts:?}"
    );
    assert!(
        !starts[1..].contains(&Some(0)),
        "the slow range started over: {starts:?}"
    );
    assert_no_sidecars(&save_path);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

#[tokio::test]
async fn a_slow_connection_lands_its_bytes_before_its_range_ends() {
    let body = segmented_test_body();
    let server = spawn_range_server(body.clone(), true).await;
    server.trickle_next.store(1, Ordering::SeqCst);
    let save_path = test_download_path("model.gguf");

    let cancel_token = CancellationToken::new();
    let running = tokio::spawn({
        let (server_url, save_path, token) =
            (server.url.clone(), save_path.clone(), cancel_token.clone());
        async move {
            let item = test_item(server_url, &save_path, SEGMENTED_TEST_SIZE as u64);
            download_single_file_with_tuning_for_test(
                mock_app().handle().clone(),
                &item,
                &save_path,
                SEGMENTED_TEST_SIZE as u64,
                false,
                token,
                segmented_test_tuning(),
            )
            .await
        }
    });

    // The map, and so the bar and the resume point, shows the trickling
    // range's bytes while it is still far from its end. They used to wait
    // for 1 MiB, or for the end of the range.
    let landed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let first_range = std::fs::read_to_string(sidecar_path(&save_path, "parts"))
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
                .and_then(|map| {
                    map["segments"]
                        .as_array()?
                        .iter()
                        .find(|range| range[0] == 0)
                        .map(|range| (range[1].as_u64().unwrap(), range[2].as_u64().unwrap()))
                });
            if let Some((written, end)) = first_range {
                if written > 0 && written < end {
                    return written;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("a slow range landed nothing until it ended");

    cancel_token.cancel();
    let cancelled = tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .expect("cancellation waited on the slow connection")
        .unwrap();
    assert_eq!(cancelled.unwrap_err(), "Download cancelled");
    assert!(super::segmented::downloaded_bytes_on_disk(&save_path) >= landed);

    server.handle.abort();
    let _ = tokio::fs::remove_dir_all(save_path.parent().unwrap()).await;
}

// ===== Windows disk reliability: locked renames, free space, FAT32 =====

mod disk_reliability {
    use super::super::disk::*;
    use super::super::helpers::{bytes_held_on_disk, sidecar_path};
    use super::super::volume::{disk_space_info, nearest_existing_dir, DiskSpaceInfo};
    use std::io::{Error, ErrorKind};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * MIB;

    // ----- Retry classification -----

    #[test]
    fn windows_lock_and_permission_errors_are_retried() {
        // ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION:
        // what Defender, the indexer and OneDrive cause on a just-finished file.
        for code in [5, 32, 33] {
            assert!(
                is_transient_lock(Some(code), ErrorKind::Other, true),
                "code {code}"
            );
        }
        assert!(is_transient_lock(None, ErrorKind::PermissionDenied, true));
        assert!(is_transient_lock(
            Some(1234),
            ErrorKind::PermissionDenied,
            true
        ));
    }

    #[test]
    fn other_windows_errors_fail_at_once() {
        // Disk full, path not found, path too long: waiting changes nothing.
        for code in [112, 39, 3, 206] {
            assert!(
                !is_transient_lock(Some(code), ErrorKind::Other, true),
                "code {code}"
            );
        }
        assert!(!is_transient_lock(None, ErrorKind::NotFound, true));
    }

    #[test]
    fn nothing_is_retried_off_windows() {
        assert!(!is_transient_lock(
            Some(5),
            ErrorKind::PermissionDenied,
            false
        ));
        assert!(!is_transient_lock(Some(32), ErrorKind::Other, false));
        #[cfg(not(windows))]
        assert!(!is_transient_lock_error(&Error::from(
            ErrorKind::PermissionDenied
        )));
    }

    #[test]
    fn the_default_lock_retry_backs_off_for_about_ten_seconds() {
        let policy = LockRetry::DEFAULT;
        let delays: Vec<u64> = (0..8).map(|n| policy.delay(n).as_millis() as u64).collect();
        assert_eq!(delays, [100, 200, 400, 800, 1600, 2000, 2000, 2000]);
        // The waits that fit the budget: no retry starts past ten seconds.
        let mut slept = Duration::ZERO;
        let mut attempt = 0;
        while slept + policy.delay(attempt) <= policy.budget {
            slept += policy.delay(attempt);
            attempt += 1;
        }
        assert!(slept >= Duration::from_secs(8), "slept {slept:?}");
        assert!(slept <= Duration::from_secs(10), "slept {slept:?}");
        // A huge attempt number neither overflows nor exceeds the cap.
        assert_eq!(policy.delay(u32::MAX), policy.max_delay);
    }

    fn quick_policy() -> LockRetry {
        LockRetry {
            budget: Duration::from_millis(40),
            first_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(4),
        }
    }

    fn locked() -> Error {
        Error::other("held by another process")
    }

    #[tokio::test]
    async fn a_lock_that_is_released_is_waited_out() {
        let calls = AtomicUsize::new(0);
        let result = retry_while_locked(
            "Renaming",
            std::path::Path::new("model.gguf.tmp"),
            quick_policy(),
            |_| true,
            || async {
                if calls.fetch_add(1, Ordering::SeqCst) < 2 {
                    Err(locked())
                } else {
                    Ok(7)
                }
            },
        )
        .await;
        assert_eq!(result.unwrap(), 7);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_lock_that_outlasts_the_budget_returns_the_last_error() {
        let calls = AtomicUsize::new(0);
        let started = std::time::Instant::now();
        let result: std::io::Result<()> = retry_while_locked(
            "Renaming",
            std::path::Path::new("model.gguf.tmp"),
            quick_policy(),
            |_| true,
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(locked())
            },
        )
        .await;
        assert_eq!(result.unwrap_err().to_string(), "held by another process");
        assert!(calls.load(Ordering::SeqCst) > 3);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn a_permanent_error_is_not_retried() {
        let calls = AtomicUsize::new(0);
        let result: std::io::Result<()> = retry_while_locked(
            "Removing",
            std::path::Path::new("model.gguf.url"),
            quick_policy(),
            |_| false,
            || async {
                calls.fetch_add(1, Ordering::SeqCst);
                Err(Error::from(ErrorKind::NotFound))
            },
        )
        .await;
        assert_eq!(result.unwrap_err().kind(), ErrorKind::NotFound);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_retrying_rename_and_removes_behave_like_the_plain_ones() {
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join("model.gguf.tmp");
        let finished = dir.path().join("model.gguf");
        tokio::fs::write(&tmp, b"weights").await.unwrap();
        rename_retrying(&tmp, &finished).await.unwrap();
        assert_eq!(tokio::fs::read(&finished).await.unwrap(), b"weights");
        assert!(!tmp.exists());
        // A missing source fails at once, tagged like any other disk error.
        let error = rename_retrying(&tmp, &finished).await.unwrap_err();
        assert_eq!(error.kind(), ErrorKind::NotFound);
        assert!(disk_err_to_string(&error).starts_with("Error: [disk_"));

        remove_file_retrying(&finished).await.unwrap();
        assert!(!finished.exists());
        // A sidecar that is already gone is what a best-effort delete wanted.
        remove_file_best_effort(&finished).await;
    }

    // ----- Required bytes -----

    #[test]
    fn headroom_is_two_percent_with_a_floor() {
        assert_eq!(free_space_headroom(0), FREE_SPACE_HEADROOM);
        assert_eq!(free_space_headroom(8 * GIB), FREE_SPACE_HEADROOM);
        // The floor and 2% meet at 25 GiB of download.
        assert_eq!(free_space_headroom(25 * GIB), FREE_SPACE_HEADROOM);
        assert_eq!(free_space_headroom(50 * GIB), GIB);
        assert_eq!(free_space_headroom(u64::MAX), u64::MAX / 100 * 2);
    }

    #[test]
    fn required_bytes_are_what_is_left_to_write_plus_headroom() {
        assert_eq!(
            required_free_bytes(10 * GIB, &[]),
            10 * GIB + FREE_SPACE_HEADROOM
        );
        // The headroom follows the whole file, not what is left of it.
        assert_eq!(required_free_bytes(50 * GIB, &[40 * GIB]), 10 * GIB + GIB);
        assert_eq!(
            required_free_bytes(10 * GIB, &[4 * GIB, GIB]),
            5 * GIB + FREE_SPACE_HEADROOM
        );
        // Everything on disk already: nothing to check.
        assert_eq!(required_free_bytes(10 * GIB, &[10 * GIB]), 0);
        assert_eq!(required_free_bytes(10 * GIB, &[20 * GIB]), 0);
        assert_eq!(required_free_bytes(0, &[]), 0);
    }

    #[test]
    fn a_refusal_names_the_required_and_free_bytes() {
        let error = check_reported_free_space(Some(3 * GIB), 10 * GIB).unwrap_err();
        assert!(error.starts_with("Error: [disk_full] "), "got {error}");
        assert!(
            error.contains("10.0 GB needed, 3.0 GB available"),
            "got {error}"
        );
        assert!(
            error.contains(&format!(
                "required {} bytes, free {} bytes",
                10 * GIB,
                3 * GIB
            )),
            "got {error}"
        );
        assert!(check_reported_free_space(Some(10 * GIB), 10 * GIB).is_ok());
        assert!(check_reported_free_space(Some(0), 0).is_ok());
    }

    #[test]
    fn the_space_a_partial_holds_is_credited_to_its_download() {
        let dir = tempfile::tempdir().unwrap();
        let save_path = dir.path().join("model.gguf");
        // No partial: only what the resume keeps (a finished copy, or nothing).
        assert_eq!(bytes_held_on_disk(&save_path, 0, 10_000), 0);
        assert_eq!(bytes_held_on_disk(&save_path, 10_000, 10_000), 10_000);

        // A single-stream partial holds what it has written.
        let tmp = sidecar_path(&save_path, "tmp");
        std::fs::write(&tmp, vec![1u8; 6_000]).unwrap();
        assert_eq!(bytes_held_on_disk(&save_path, 6_000, 10_000), 6_000);
        // Even one a resume cannot reuse: it is truncated before anything new
        // is written, so its space comes back to this download.
        assert_eq!(bytes_held_on_disk(&save_path, 0, 10_000), 6_000);
        // Never more than the file itself.
        assert_eq!(bytes_held_on_disk(&save_path, 6_000, 4_000), 4_000);
        // Unknown size: no clamp.
        assert_eq!(bytes_held_on_disk(&save_path, 0, 0), 6_000);
    }

    #[cfg(unix)]
    #[test]
    fn a_sparse_full_size_partial_holds_only_its_written_bytes_on_unix() {
        let dir = tempfile::tempdir().unwrap();
        let save_path = dir.path().join("model.gguf");
        let tmp = sidecar_path(&save_path, "tmp");
        // A multi-connection partial: pre-sized, nothing written.
        let file = std::fs::File::create(&tmp).unwrap();
        file.set_len(64 * MIB).unwrap();
        drop(file);
        // What its segment map says is written is the floor; the sparse file
        // adds next to nothing on top.
        let held = bytes_held_on_disk(&save_path, 1_000, 64 * MIB);
        assert!(held >= 1_000, "held {held}");
        assert!(
            held < 64 * MIB,
            "a sparse partial was counted at full size: {held}"
        );
    }

    // ----- The FAT rule -----

    #[test]
    fn fat_volumes_refuse_files_of_four_gib_and_more() {
        let four_gib = 4 * GIB;
        let error = fs_file_limit_error(Some("FAT32"), four_gib).expect("refused");
        assert!(error.starts_with("Error: [disk_fs_limit] "), "got {error}");
        assert!(error.contains("FAT32"), "got {error}");
        assert!(error.contains("NTFS or exFAT"), "got {error}");
        assert!(fs_file_limit_error(Some("FAT"), 20 * GIB).is_some());
        assert!(fs_file_limit_error(Some("fat32"), 20 * GIB).is_some());
        // The largest file FAT32 can hold still fits.
        assert_eq!(FAT_MAX_FILE_BYTES, four_gib - 1);
        assert_eq!(fs_file_limit_error(Some("FAT32"), four_gib - 1), None);
    }

    #[test]
    fn other_file_systems_take_any_size() {
        for fs_name in ["NTFS", "exFAT", "ReFS", "apfs", ""] {
            assert_eq!(
                fs_file_limit_error(Some(fs_name), 27 * GIB),
                None,
                "{fs_name}"
            );
        }
        // Unknown file system: let the download try.
        assert_eq!(fs_file_limit_error(None, 27 * GIB), None);
        assert!(!is_fat_file_system("exFAT"));
        assert!(is_fat_file_system("FAT16"));
    }

    #[cfg(not(windows))]
    #[test]
    fn the_fat_preflight_is_a_no_op_off_windows() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ensure_file_fits_file_system(&dir.path().join("model.gguf"), 27 * GIB).is_ok());
    }

    // ----- Tags -----

    #[test]
    fn every_tag_parses_back_to_its_fault() {
        for fault in DiskFault::ALL {
            assert_eq!(DiskFault::from_tag(fault.tag()), Some(fault));
            let message = disk_fault_message(fault, "detail");
            assert_eq!(disk_fault_in(&message), Some(fault), "{message}");
        }
        assert_eq!(
            DiskFault::from_tag("disk_fs_limit"),
            Some(DiskFault::FsLimit)
        );
    }

    #[test]
    fn tag_parsing_reads_the_first_known_disk_tag() {
        assert_eq!(
            disk_fault_in("Error: [disk_file_locked] os error 32 (failed to flush)"),
            Some(DiskFault::FileLocked)
        );
        let error = std::io::Error::from_raw_os_error(2);
        assert!(disk_fault_in(&disk_err_to_string(&error)).is_some());
        // Untagged, unknown or unterminated: no guess.
        assert_eq!(disk_fault_in("Error: connection refused"), None);
        assert_eq!(disk_fault_in("Error: [disk_brand_new] detail"), None);
        assert_eq!(disk_fault_in("Error: [disk_full"), None);
        assert_eq!(disk_fault_in("[network] no route"), None);
    }

    // ----- The volume query -----

    #[test]
    fn a_destination_that_does_not_exist_yet_is_measured_through_its_ancestor() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("llamacpp/models/new-model/model.gguf");
        assert_eq!(nearest_existing_dir(&target).as_deref(), Some(dir.path()));
        let info = disk_space_info(&target).expect("measured");
        assert!(info.total_bytes > 0);
        assert!(info.free_bytes <= info.total_bytes);
        // The free-space check reads the same number.
        assert!(available_space_for(&target).is_some());
    }

    #[test]
    fn disk_space_info_serializes_in_snake_case() {
        let info = DiskSpaceInfo {
            free_bytes: 5 * GIB,
            total_bytes: 100 * GIB,
            fs_name: Some("NTFS".to_string()),
            volume_root: Some(r"D:\".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            serde_json::json!({
                "free_bytes": 5_368_709_120u64,
                "total_bytes": 107_374_182_400u64,
                "fs_name": "NTFS",
                "volume_root": "D:\\",
            })
        );
        let unnamed = DiskSpaceInfo {
            fs_name: None,
            volume_root: None,
            ..info
        };
        let value = serde_json::to_value(&unnamed).unwrap();
        assert_eq!(value["fs_name"], serde_json::Value::Null);
        assert_eq!(value["volume_root"], serde_json::Value::Null);
    }
}
