use std::path::{Component, Path};

pub fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() || session_id.len() > 128 {
        return Err("session_id must be a non-empty path component".into());
    }
    let path = Path::new(session_id);
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("session_id must be a safe single path component".into());
    }
    Ok(())
}
