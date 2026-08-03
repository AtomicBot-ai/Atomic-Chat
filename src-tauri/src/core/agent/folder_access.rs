use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::tools::FolderAccessHook;
use super::types::{AgentEvent, FolderAccessRequest};
use crate::core::state::PendingAgentFolderAccess;

const DEFAULT_FOLDER_ACCESS_TIMEOUT: Duration = Duration::from_secs(120);

type PendingFolderAccess = Arc<Mutex<HashMap<String, PendingAgentFolderAccess>>>;
type EventSink = Arc<dyn Fn(AgentEvent) -> Result<(), String> + Send + Sync>;

pub struct FolderAccessGate {
    run_id: String,
    pending: PendingFolderAccess,
    emit: EventSink,
    cancellation: CancellationToken,
    timeout: Duration,
}

impl FolderAccessGate {
    pub fn new(
        run_id: String,
        pending: PendingFolderAccess,
        emit: EventSink,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            run_id,
            pending,
            emit,
            cancellation,
            timeout: DEFAULT_FOLDER_ACCESS_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

#[async_trait]
impl FolderAccessHook for FolderAccessGate {
    async fn request(&self, request: FolderAccessRequest) -> Result<bool, String> {
        let access_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(
            access_id.clone(),
            PendingAgentFolderAccess {
                run_id: self.run_id.clone(),
                sender,
            },
        );

        if let Err(error) = (self.emit)(AgentEvent::FolderAccessRequested {
            run_id: self.run_id.clone(),
            access_id: access_id.clone(),
            tool: request.tool,
            path: request.path,
            display_name: request.display_name,
            root_id: request.root_id,
            reason: request.reason,
        }) {
            self.pending.lock().await.remove(&access_id);
            return Err(error);
        }

        let allowed = tokio::select! {
            result = receiver => result.unwrap_or(false),
            _ = self.cancellation.cancelled() => false,
            _ = tokio::time::sleep(self.timeout) => false,
        };
        self.pending.lock().await.remove(&access_id);
        Ok(allowed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn request() -> FolderAccessRequest {
        FolderAccessRequest {
            tool: "os.fs.write".into(),
            path: "/tmp/Desktop".into(),
            display_name: "Desktop".into(),
            root_id: "root-id".into(),
            reason: "Access is required to write outside connected folders".into(),
        }
    }

    #[tokio::test]
    async fn waits_for_a_matching_decision() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let emitted = Arc::new(StdMutex::new(Vec::new()));
        let sink = emitted.clone();
        let gate = Arc::new(FolderAccessGate::new(
            "run-a".into(),
            pending.clone(),
            Arc::new(move |event| {
                sink.lock().unwrap().push(event);
                Ok(())
            }),
            CancellationToken::new(),
        ));
        let task = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.request(request()).await })
        };

        tokio::task::yield_now().await;
        let access_id = match &emitted.lock().unwrap()[0] {
            AgentEvent::FolderAccessRequested { access_id, .. } => access_id.clone(),
            event => panic!("unexpected event: {event:?}"),
        };
        pending
            .lock()
            .await
            .remove(&access_id)
            .unwrap()
            .sender
            .send(true)
            .unwrap();

        assert!(task.await.unwrap().unwrap());
        assert!(pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn timeout_denies_and_cleans_pending_request() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let gate = FolderAccessGate::new(
            "run-a".into(),
            pending.clone(),
            Arc::new(|_| Ok(())),
            CancellationToken::new(),
        )
        .with_timeout(Duration::from_millis(1));

        assert!(!gate.request(request()).await.unwrap());
        assert!(pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn cancellation_denies_and_cleans_pending_request() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let cancellation = CancellationToken::new();
        let gate = Arc::new(FolderAccessGate::new(
            "run-a".into(),
            pending.clone(),
            Arc::new(|_| Ok(())),
            cancellation.clone(),
        ));
        let task = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.request(request()).await })
        };
        tokio::task::yield_now().await;
        cancellation.cancel();

        assert!(!task.await.unwrap().unwrap());
        assert!(pending.lock().await.is_empty());
    }
}
