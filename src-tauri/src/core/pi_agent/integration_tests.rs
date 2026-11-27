use super::{
    process,
    profile::{profile_dir, StartRequest},
};
use hyper::{
    service::{make_service_fn, service_fn},
    Body, Request, Response, Server,
};
use serde_json::{json, Value};
use std::{convert::Infallible, path::Path, time::Duration};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

async fn completion(request: Request<Body>) -> Result<Response<Body>, Infallible> {
    assert_eq!(request.uri().path(), "/custom/chat/completions");
    assert_eq!(request.headers()["authorization"], "Bearer fixture");
    let body = hyper::body::to_bytes(request.into_body()).await.unwrap();
    let chat: Value = serde_json::from_slice(&body).unwrap();
    if chat["model"] == "second" {
        assert!(
            chat.get("chat_template_kwargs").is_none(),
            "Strata uses its OpenAI transport"
        );
        assert!(chat["tools"]
            .as_array()
            .is_some_and(|tools| !tools.is_empty()));
    }
    let finished = chat["messages"].as_array().unwrap().last().unwrap()["role"] == "tool";
    let (delta, reason) = if finished {
        (json!({"role":"assistant","content":"Finished"}), "stop")
    } else {
        (
            json!({"role":"assistant","tool_calls":[{"index":0,"id":"call-one","type":"function","function":{"name":"write","arguments":r#"{"path":"marker","content":"approved"}"#}}]}),
            "tool_calls",
        )
    };
    let mut stream = String::new();
    for (delta, end) in [(delta, Value::Null), (json!({}), json!(reason))] {
        let chunk = json!({"id":"local","object":"chat.completion.chunk","created":1,"model":chat["model"],
            "choices":[{"index":0,"delta":delta,"finish_reason":end}]});
        stream.push_str(&format!("data: {chunk}\n\n"));
    }
    stream.push_str("data: [DONE]\n\n");
    Ok(Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from(stream))
        .unwrap())
}

fn channel() -> (Channel<Value>, UnboundedReceiver<Value>) {
    let (sender, receiver) = unbounded_channel();
    (
        Channel::new(move |body| {
            if let InvokeResponseBody::Json(text) = body {
                let _ = sender.send(serde_json::from_str(&text).unwrap());
            }
            Ok(())
        }),
        receiver,
    )
}

async fn next(events: &mut UnboundedReceiver<Value>, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let item = events.recv().await.expect("live pi channel");
            assert_ne!(item["type"], "exit", "{item}");
            if item["type"] == kind {
                return item;
            }
        }
    })
    .await
    .expect("expected RPC event")
}

#[tokio::test]
#[ignore = "requires the downloaded standalone pi distribution"]
async fn shipped_pi_replays_approval_and_resumes_after_model_change() {
    let scratch = tempfile::tempdir().unwrap();
    let dir = profile_dir(scratch.path(), "fixture").unwrap();
    let workspace = scratch.path().join("work");
    std::fs::create_dir(&workspace).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = Server::from_tcp(listener)
        .unwrap()
        .serve(make_service_fn(|_| async {
            Ok::<_, Infallible>(service_fn(completion))
        }));
    let http = tokio::spawn(server);
    let binary = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources/pi")
        .join(if cfg!(windows) { "pi.exe" } else { "pi" });
    let mut req: StartRequest=serde_json::from_value(json!({"threadId":"fixture","cwd":workspace,"baseUrl":format!("http://{address}/custom"),"model":"first","localModel":true,"apiKey":"fixture","contextWindow":32768})).unwrap();
    let (sink, mut events) = channel();
    let session = process::launch(binary.clone(), dir.clone(), req.clone(), sink, None)
        .await
        .unwrap();
    let timeout = Duration::from_secs(10);
    let session_file = session.info.lock().unwrap()["sessionFile"]
        .as_str()
        .unwrap()
        .to_owned();
    let (a, b) = tokio::join!(
        session.call(json!({"type":"get_state"}), timeout),
        session.call(json!({"type":"get_commands"}), timeout)
    );
    assert_eq!(a.unwrap()["model"]["id"], "first");
    assert!(b.unwrap()["commands"].is_array());
    session
        .call(
            json!({"type":"prompt","message":"Write the marker"}),
            timeout,
        )
        .await
        .unwrap();
    let approval = next(&mut events, "extension_ui_request").await;
    assert_eq!(approval["method"], "select");
    assert!(session.idle_for().is_none());
    let (fresh, mut events) = channel();
    session.reconnect(fresh);
    assert_eq!(
        next(&mut events, "extension_ui_request").await["id"],
        approval["id"]
    );
    assert!(!workspace.join("marker").exists());
    session
        .respond(json!({"type":"extension_ui_response","id":approval["id"],"value":"Deny"}))
        .await
        .unwrap();
    assert_eq!(
        next(&mut events, "tool_execution_end").await["isError"],
        true
    );
    next(&mut events, "agent_settled").await;
    assert!(!workspace.join("marker").exists());
    session.stop().await;
    req.model = "second".into();
    req.provider = "strata".into();
    req.session_file = Some(session_file.clone().into());
    let (fresh, mut events) = channel();
    let resumed = process::launch(binary.clone(), dir.clone(), req, fresh, None)
        .await
        .unwrap();
    assert_eq!(resumed.info.lock().unwrap()["sessionFile"], session_file);
    let entries = resumed
        .call(json!({"type":"get_entries"}), timeout)
        .await
        .unwrap();
    assert!(entries["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["message"]["role"] == "toolResult" && e["message"]["isError"] == true));
    resumed
        .call(json!({"type":"prompt","message":"Write it now"}), timeout)
        .await
        .unwrap();
    let approval = next(&mut events, "extension_ui_request").await;
    resumed
        .respond(json!({"type":"extension_ui_response","id":approval["id"],"value":"Allow"}))
        .await
        .unwrap();
    next(&mut events, "agent_settled").await;
    assert_eq!(
        std::fs::read_to_string(workspace.join("marker")).unwrap(),
        "approved"
    );
    resumed
        .call(
            json!({"type":"prompt","message":"Hold for approval"}),
            timeout,
        )
        .await
        .unwrap();
    next(&mut events, "extension_ui_request").await;
    resumed
        .call(json!({"type":"abort"}), timeout)
        .await
        .unwrap();
    next(&mut events, "agent_settled").await;
    assert!(resumed.idle_for().is_some());
    // Startup reaping verifies both the kernel start time and the executable before
    // terminating a child left behind by a previous instance of Atomic Chat.
    super::journal::reap(scratch.path(), &binary);
    tokio::time::timeout(timeout, async {
        while let Some(event) = events.recv().await {
            if event["type"] == "exit" {
                return;
            }
        }
        panic!("missing exit after orphan reaping");
    })
    .await
    .expect("orphaned group stopped");
    resumed.stop().await;
    assert!(!dir.join("process.json").exists());
    http.abort();
}
