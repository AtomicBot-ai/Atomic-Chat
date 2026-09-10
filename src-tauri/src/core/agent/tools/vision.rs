use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde_json::Value;

use super::{required_string, resolve_path, truncate, ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::attachments::detect_image_media_type;
use crate::core::agent::types::ToolOutcome;

const MAX_IMAGES: usize = 4;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

pub async fn describe(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let prompt = required_string(args, "prompt").map_err(ToolOutcome::error)?;
    let paths = args
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolOutcome::error("`paths` must be a non-empty array"))?;
    if paths.is_empty() || paths.len() > MAX_IMAGES {
        return Err(ToolOutcome::error(format!(
            "`paths` must contain between 1 and {MAX_IMAGES} images"
        )));
    }
    let mut images = Vec::with_capacity(paths.len());
    for value in paths {
        let raw = value
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ToolOutcome::error("Every image path must be a non-empty string"))?;
        let path = resolve_path(context.working_dir, raw);
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| ToolOutcome::error(format!("{}: {error}", path.display())))?;
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err(ToolOutcome::error(format!(
                "{} must be between 1 byte and {MAX_IMAGE_BYTES} bytes",
                path.display()
            )));
        }
        let media_type = detect_image_media_type(&bytes).ok_or_else(|| {
            ToolOutcome::error(format!("{} is not a supported image", path.display()))
        })?;
        images.push((media_type.to_owned(), BASE64_STANDARD.encode(bytes)));
    }
    let client = context
        .client
        .ok_or_else(|| ToolOutcome::error("Vision client is unavailable"))?;
    let description = client
        .describe_images(&prompt, &images, context.cancellation)
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    Ok(ToolOutcome::ok(truncate(
        description,
        MAX_TOOL_OUTPUT_CHARS,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_images_from_bytes() {
        assert_eq!(
            detect_image_media_type(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(
            detect_image_media_type(b"\xff\xd8\xffrest"),
            Some("image/jpeg")
        );
        assert_eq!(detect_image_media_type(b"not-an-image"), None);
    }
}
