use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub async fn read_record(
    reader: &mut (impl AsyncBufRead + Unpin),
) -> Result<Option<Value>, String> {
    let mut bytes = Vec::new();
    loop {
        let block = reader.fill_buf().await.map_err(|e| e.to_string())?;
        if block.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("Truncated pi RPC record".into())
            };
        }
        let lf = block.iter().position(|&b| b == b'\n');
        let count = lf.unwrap_or(block.len());
        if bytes.len() + count > 32 * 1024 * 1024 {
            return Err("pi RPC record exceeds 32 MiB".into());
        }
        bytes.extend_from_slice(&block[..count]);
        reader.consume(count + usize::from(lf.is_some()));
        if lf.is_some() {
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "Invalid pi RPC JSON".into());
        }
    }
}

pub fn command_allowed(command: &Value) -> bool {
    matches!(
        command["type"].as_str(),
        Some(
            "prompt"
                | "abort"
                | "steer"
                | "follow_up"
                | "clear_queue"
                | "get_state"
                | "get_commands"
                | "get_messages"
                | "get_entries"
                | "get_session_stats"
                | "get_available_models"
                | "get_available_thinking_levels"
                | "set_thinking_level"
                | "compact"
                | "abort_retry"
                | "set_session_name"
        )
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncWriteExt, BufReader};
    #[tokio::test]
    async fn records_use_lf_and_reject_a_truncated_tail() {
        let (mut tx, rx) = tokio::io::duplex(4);
        let writer = tokio::spawn(async move {
            tx.write_all(b"{\"a\":1}\r\n{\"b\":2}\n{").await.unwrap();
        });
        let mut reader = BufReader::new(rx);
        assert_eq!(read_record(&mut reader).await.unwrap().unwrap()["a"], 1);
        assert_eq!(read_record(&mut reader).await.unwrap().unwrap()["b"], 2);
        assert!(read_record(&mut reader).await.is_err());
        writer.await.unwrap();
    }
}
