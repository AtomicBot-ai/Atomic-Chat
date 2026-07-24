//! Resource-class-aware execution for one parsed tool-call batch.

use std::future::Future;

use futures_util::future::join_all;

use super::resource_class::{is_parallel_within_group, resource_class_for, ResourceClass};
use super::tools::{self, ToolContext};
use super::types::{ToolCallPayload, ToolOutcome};

#[derive(Debug)]
pub(crate) enum PlannedCall {
    Execute,
    Denied(ToolOutcome),
}

pub(crate) async fn execute_batch(
    calls: &[ToolCallPayload],
    planned: &[PlannedCall],
    context: &ToolContext<'_>,
) -> Vec<ToolOutcome> {
    debug_assert_eq!(calls.len(), planned.len());
    let has_terminal_tail = calls
        .last()
        .is_some_and(|call| resource_class_for(&call.tool) == ResourceClass::Terminal);
    let non_terminal_len = calls.len() - usize::from(has_terminal_tail);
    let classes = calls[..non_terminal_len]
        .iter()
        .map(|call| resource_class_for(&call.tool))
        .collect::<Vec<_>>();
    execute_with_terminal_tail(
        &classes,
        has_terminal_tail.then_some(non_terminal_len),
        |index| async move { execute_one(&calls[index], &planned[index], context).await },
    )
    .await
}

async fn execute_one(
    call: &ToolCallPayload,
    planned: &PlannedCall,
    context: &ToolContext<'_>,
) -> ToolOutcome {
    match planned {
        // Keep the large tool-dispatch future off Tokio's worker stack. The
        // grouped executor adds several nested future layers around this call.
        PlannedCall::Execute => Box::pin(tools::execute(call, context)).await,
        PlannedCall::Denied(outcome) => outcome.clone(),
    }
}

async fn execute_grouped_by_class<T, Execute, ExecuteFuture>(
    classes: &[ResourceClass],
    execute: Execute,
) -> Vec<T>
where
    T: Send,
    Execute: Fn(usize) -> ExecuteFuture + Sync,
    ExecuteFuture: Future<Output = T> + Send,
{
    let mut groups: Vec<(ResourceClass, Vec<usize>)> = Vec::new();
    for (index, class) in classes.iter().copied().enumerate() {
        if let Some((_, indices)) = groups.iter_mut().find(|(group, _)| *group == class) {
            indices.push(index);
        } else {
            groups.push((class, vec![index]));
        }
    }

    let execute = &execute;
    let grouped = join_all(groups.iter().map(|(class, indices)| async move {
        if is_parallel_within_group(*class) {
            join_all(
                indices
                    .iter()
                    .copied()
                    .map(|index| async move { (index, execute(index).await) }),
            )
            .await
        } else {
            let mut results = Vec::with_capacity(indices.len());
            for index in indices.iter().copied() {
                results.push((index, execute(index).await));
            }
            results
        }
    }))
    .await;

    let mut ordered = grouped.into_iter().flatten().collect::<Vec<_>>();
    ordered.sort_by_key(|(index, _)| *index);
    ordered.into_iter().map(|(_, outcome)| outcome).collect()
}

async fn execute_with_terminal_tail<T, Execute, ExecuteFuture>(
    classes: &[ResourceClass],
    terminal_index: Option<usize>,
    execute: Execute,
) -> Vec<T>
where
    T: Send,
    Execute: Fn(usize) -> ExecuteFuture + Sync,
    ExecuteFuture: Future<Output = T> + Send,
{
    let execute = &execute;
    let mut outcomes = execute_grouped_by_class(classes, |index| execute(index)).await;
    if let Some(index) = terminal_index {
        outcomes.push(execute(index).await);
    }
    outcomes
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::core::agent::types::ToolStatus;

    fn record_max(maximum: &AtomicUsize, value: usize) {
        maximum.fetch_max(value, Ordering::SeqCst);
    }

    #[tokio::test]
    async fn follows_resource_class_concurrency_and_preserves_result_order() {
        let read_active = Arc::new(AtomicUsize::new(0));
        let read_max = Arc::new(AtomicUsize::new(0));
        let write_active = Arc::new(AtomicUsize::new(0));
        let write_max = Arc::new(AtomicUsize::new(0));
        let global_active = Arc::new(AtomicUsize::new(0));
        let global_max = Arc::new(AtomicUsize::new(0));
        let classes = [
            ResourceClass::PureRead,
            ResourceClass::MemoryWrite,
            ResourceClass::PureRead,
            ResourceClass::MemoryWrite,
        ];

        let results = execute_grouped_by_class(&classes, |index| {
            let read_active = Arc::clone(&read_active);
            let read_max = Arc::clone(&read_max);
            let write_active = Arc::clone(&write_active);
            let write_max = Arc::clone(&write_max);
            let global_active = Arc::clone(&global_active);
            let global_max = Arc::clone(&global_max);
            async move {
                let (active, maximum) = if matches!(index, 0 | 2) {
                    (&read_active, &read_max)
                } else {
                    (&write_active, &write_max)
                };
                let class_active = active.fetch_add(1, Ordering::SeqCst) + 1;
                record_max(maximum, class_active);
                let all_active = global_active.fetch_add(1, Ordering::SeqCst) + 1;
                record_max(&global_max, all_active);
                tokio::time::sleep(Duration::from_millis(20)).await;
                global_active.fetch_sub(1, Ordering::SeqCst);
                active.fetch_sub(1, Ordering::SeqCst);
                index
            }
        })
        .await;

        assert_eq!(results, [0, 1, 2, 3]);
        assert_eq!(read_max.load(Ordering::SeqCst), 2);
        assert_eq!(write_max.load(Ordering::SeqCst), 1);
        assert!(global_max.load(Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn isolates_error_outcomes_from_siblings() {
        let classes = [ResourceClass::PureRead; 3];
        let results = execute_grouped_by_class(&classes, |index| async move {
            if index == 1 {
                ToolOutcome::error("failed")
            } else {
                ToolOutcome::ok(format!("ok-{index}"))
            }
        })
        .await;

        assert_eq!(results[0].status, ToolStatus::Ok);
        assert_eq!(results[1].status, ToolStatus::Error);
        assert_eq!(results[2].status, ToolStatus::Ok);
    }

    #[tokio::test]
    async fn serial_groups_observe_cancellation_before_later_calls() {
        let cancellation = CancellationToken::new();
        let classes = [ResourceClass::MemoryWrite; 3];
        let results = execute_grouped_by_class(&classes, |index| {
            let cancellation = cancellation.clone();
            async move {
                if index == 0 {
                    cancellation.cancel();
                    ToolOutcome::ok("first")
                } else if cancellation.is_cancelled() {
                    ToolOutcome {
                        status: ToolStatus::Cancelled,
                        summary: "cancelled".into(),
                        details: None,
                    }
                } else {
                    ToolOutcome::ok("unexpected")
                }
            }
        })
        .await;

        assert_eq!(results[0].status, ToolStatus::Ok);
        assert_eq!(results[1].status, ToolStatus::Cancelled);
        assert_eq!(results[2].status, ToolStatus::Cancelled);
    }

    #[tokio::test]
    async fn executes_vision_calls_serially_in_batch_order() {
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let classes = [ResourceClass::Vision; 3];

        let results = execute_grouped_by_class(&classes, |index| {
            let active = Arc::clone(&active);
            let maximum = Arc::clone(&maximum);
            async move {
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                record_max(&maximum, current);
                tokio::time::sleep(Duration::from_millis(5)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                index
            }
        })
        .await;

        assert_eq!(results, [0, 1, 2]);
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn executes_terminal_tail_after_every_non_terminal_group() {
        let completed = Arc::new(AtomicUsize::new(0));
        let terminal_saw = Arc::new(AtomicUsize::new(0));
        let classes = [ResourceClass::PureRead, ResourceClass::MemoryWrite];

        let results = execute_with_terminal_tail(&classes, Some(2), |index| {
            let completed = Arc::clone(&completed);
            let terminal_saw = Arc::clone(&terminal_saw);
            async move {
                if index == 2 {
                    terminal_saw.store(completed.load(Ordering::SeqCst), Ordering::SeqCst);
                } else {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    completed.fetch_add(1, Ordering::SeqCst);
                }
                index
            }
        })
        .await;

        assert_eq!(results, [0, 1, 2]);
        assert_eq!(terminal_saw.load(Ordering::SeqCst), 2);
    }
}
