use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::{oneshot, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::tools::ApprovalHook;
use super::types::{AgentEvent, ApprovalDecision, ApprovalRequest};
use crate::core::agent::approval_allowlist::ApprovalAllowlist;
use crate::core::state::PendingAgentApproval;

const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);

type PendingApprovals = Arc<Mutex<HashMap<String, PendingAgentApproval>>>;
type EventSink = Arc<dyn Fn(AgentEvent) -> Result<(), String> + Send + Sync>;

pub struct ApprovalGate {
    run_id: String,
    auto_approve: bool,
    pending: PendingApprovals,
    allowlist: Arc<Mutex<ApprovalAllowlist>>,
    emit: EventSink,
    cancellation: CancellationToken,
    timeout: Duration,
}

impl ApprovalGate {
    pub fn new(
        run_id: String,
        auto_approve: bool,
        pending: PendingApprovals,
        allowlist: Arc<Mutex<ApprovalAllowlist>>,
        emit: EventSink,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            run_id,
            auto_approve,
            pending,
            allowlist,
            emit,
            cancellation,
            timeout: DEFAULT_APPROVAL_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

#[async_trait]
impl ApprovalHook for ApprovalGate {
    async fn is_allowed(&self, fingerprint: &str) -> bool {
        self.allowlist.lock().await.contains(fingerprint)
    }

    async fn request(&self, request: ApprovalRequest) -> Result<ApprovalDecision, String> {
        if self.auto_approve {
            return Ok(ApprovalDecision::AllowOnce);
        }

        let approval_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(
            approval_id.clone(),
            PendingAgentApproval {
                run_id: self.run_id.clone(),
                fingerprint: request.fingerprint,
                can_remember: request.can_remember,
                sender,
            },
        );

        if let Err(error) = (self.emit)(AgentEvent::ApprovalRequested {
            run_id: self.run_id.clone(),
            approval_id: approval_id.clone(),
            tool: request.tool,
            reason: request.reason,
            preview: request.preview,
            affected_resources: request.affected_resources,
            can_remember: request.can_remember,
        }) {
            self.pending.lock().await.remove(&approval_id);
            return Err(error);
        }

        let decision = tokio::select! {
            result = receiver => result.unwrap_or(ApprovalDecision::Deny),
            _ = self.cancellation.cancelled() => ApprovalDecision::Deny,
            _ = tokio::time::sleep(self.timeout) => ApprovalDecision::Deny,
        };
        self.pending.lock().await.remove(&approval_id);
        Ok(decision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::types::ApprovalResource;
    use std::sync::Mutex as StdMutex;

    fn request() -> ApprovalRequest {
        ApprovalRequest {
            tool: "os.fs.write".into(),
            reason: "Filesystem write".into(),
            preview: serde_json::json!({"path": "/tmp/work/file"}),
            affected_resources: vec![ApprovalResource {
                kind: "path".into(),
                value: "/tmp/work/file".into(),
                operation: "write".into(),
            }],
            fingerprint: "a".repeat(64),
            can_remember: true,
        }
    }

    fn allowlist() -> Arc<Mutex<ApprovalAllowlist>> {
        Arc::new(Mutex::new(ApprovalAllowlist::default()))
    }

    #[tokio::test]
    async fn auto_approve_skips_pending_request() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let gate = ApprovalGate::new(
            "run".into(),
            true,
            pending.clone(),
            allowlist(),
            Arc::new(|_| panic!("auto approval must not emit")),
            CancellationToken::new(),
        );
        assert_eq!(
            gate.request(request()).await.unwrap(),
            ApprovalDecision::AllowOnce
        );
        assert!(pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn waits_for_and_applies_decision() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let emitted = Arc::new(StdMutex::new(Vec::new()));
        let emitted_for_sink = emitted.clone();
        let gate = Arc::new(ApprovalGate::new(
            "run".into(),
            false,
            pending.clone(),
            allowlist(),
            Arc::new(move |event| {
                emitted_for_sink.lock().unwrap().push(event);
                Ok(())
            }),
            CancellationToken::new(),
        ));
        let task = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.request(request()).await })
        };

        tokio::task::yield_now().await;
        let approval_id = match &emitted.lock().unwrap()[0] {
            AgentEvent::ApprovalRequested { approval_id, .. } => approval_id.clone(),
            event => panic!("unexpected event: {event:?}"),
        };
        let pending_request = pending.lock().await.remove(&approval_id).unwrap();
        pending_request
            .sender
            .send(ApprovalDecision::AllowOnce)
            .unwrap();

        assert_eq!(task.await.unwrap().unwrap(), ApprovalDecision::AllowOnce);
        assert!(pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn timeout_denies_and_cleans_pending_request() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let gate = ApprovalGate::new(
            "run".into(),
            false,
            pending.clone(),
            allowlist(),
            Arc::new(|_| Ok(())),
            CancellationToken::new(),
        )
        .with_timeout(Duration::from_millis(1));
        assert_eq!(
            gate.request(request()).await.unwrap(),
            ApprovalDecision::Deny
        );
        assert!(pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn cancellation_denies_and_cleans_pending_request() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let cancellation = CancellationToken::new();
        let gate = Arc::new(ApprovalGate::new(
            "run".into(),
            false,
            pending.clone(),
            allowlist(),
            Arc::new(|_| Ok(())),
            cancellation.clone(),
        ));
        let task = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.request(request()).await })
        };

        tokio::task::yield_now().await;
        cancellation.cancel();

        assert_eq!(task.await.unwrap().unwrap(), ApprovalDecision::Deny);
        assert!(pending.lock().await.is_empty());
    }
}
