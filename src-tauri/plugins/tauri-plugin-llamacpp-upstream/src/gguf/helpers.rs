use byteorder::{LittleEndian, ReadBytesExt};
use std::convert::TryFrom;
use std::io::{self, BufReader, Read, Seek};

use super::types::{GgufMetadata, GgufValueType};

#[cfg(target_os = "macos")]
use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::fs::File;
#[cfg(target_os = "macos")]
use crate::error::{ErrorCode, LlamacppError};

pub fn read_gguf_metadata<R: Read + Seek>(reader: R) -> io::Result<GgufMetadata> {
    let mut file = BufReader::new(reader);

    let mut magic = [0u8; 4];
    file.read_exact(&mut magic)?;
    if &magic != b"GGUF" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Not a GGUF file",
        ));
    }

    let version = file.read_u32::<LittleEndian>()?;
    let tensor_count = file.read_u64::<LittleEndian>()?;
    let metadata_count = file.read_u64::<LittleEndian>()?;

    let mut metadata_map = std::collections::HashMap::new();
    for i in 0..metadata_count {
        match read_metadata_entry(&mut file, i) {
            Ok((key, value)) => {
                metadata_map.insert(key, value);
            }
            Err(e) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Error reading metadata entry {}: {}", i, e),
                ));
            }
        }
    }

    Ok(GgufMetadata {
        version,
        tensor_count,
        metadata: metadata_map,
    })
}

fn read_metadata_entry<R: Read + Seek>(reader: &mut R, index: u64) -> io::Result<(String, String)>
where
    R: ReadBytesExt,
{
    let key = read_gguf_string(reader).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Failed to read key for metadata entry {}: {}", index, e),
        )
    })?;

    let value_type_u32 = reader.read_u32::<LittleEndian>()?;
    let value_type = GgufValueType::try_from(value_type_u32)?;
    let value = read_gguf_value(reader, value_type)?;

    Ok((key, value))
}

fn read_gguf_string<R: Read>(reader: &mut R) -> io::Result<String>
where
    R: ReadBytesExt,
{
    let len = reader.read_u64::<LittleEndian>()?;
    if len > (1024 * 1024) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("String length {} is unreasonably large", len),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf)?;
    Ok(String::from_utf8(buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?)
}

fn read_gguf_value<R: Read + Seek>(reader: &mut R, value_type: GgufValueType) -> io::Result<String>
where
    R: ReadBytesExt,
{
    match value_type {
        GgufValueType::Uint8 => Ok(reader.read_u8()?.to_string()),
        GgufValueType::Int8 => Ok(reader.read_i8()?.to_string()),
        GgufValueType::Uint16 => Ok(reader.read_u16::<LittleEndian>()?.to_string()),
        GgufValueType::Int16 => Ok(reader.read_i16::<LittleEndian>()?.to_string()),
        GgufValueType::Uint32 => Ok(reader.read_u32::<LittleEndian>()?.to_string()),
        GgufValueType::Int32 => Ok(reader.read_i32::<LittleEndian>()?.to_string()),
        GgufValueType::Float32 => Ok(reader.read_f32::<LittleEndian>()?.to_string()),
        GgufValueType::Bool => Ok((reader.read_u8()? != 0).to_string()),
        GgufValueType::String => read_gguf_string(reader),
        GgufValueType::Uint64 => Ok(reader.read_u64::<LittleEndian>()?.to_string()),
        GgufValueType::Int64 => Ok(reader.read_i64::<LittleEndian>()?.to_string()),
        GgufValueType::Float64 => Ok(reader.read_f64::<LittleEndian>()?.to_string()),
        GgufValueType::Array => {
            let elem_type_u32 = reader.read_u32::<LittleEndian>()?;
            let elem_type = GgufValueType::try_from(elem_type_u32)?;
            let len = reader.read_u64::<LittleEndian>()?;

            if len > 1_000_000 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("Array length {} is unreasonably large", len),
                ));
            }

            if len > 24 {
                skip_array_data(reader, elem_type, len)?;
                return Ok(format!(
                    "<Array of type {:?} with {} elements, data skipped>",
                    elem_type, len
                ));
            }

            let mut elems = Vec::with_capacity(len as usize);
            for _ in 0..len {
                elems.push(read_gguf_value(reader, elem_type)?);
            }
            Ok(format!("[{}]", elems.join(", ")))
        }
    }
}

fn skip_array_data<R: Read + Seek>(
    reader: &mut R,
    elem_type: GgufValueType,
    len: u64,
) -> io::Result<()>
where
    R: ReadBytesExt,
{
    match elem_type {
        GgufValueType::Uint8 | GgufValueType::Int8 | GgufValueType::Bool => {
            reader.seek(io::SeekFrom::Current(len as i64))?;
        }
        GgufValueType::Uint16 | GgufValueType::Int16 => {
            reader.seek(io::SeekFrom::Current((len * 2) as i64))?;
        }
        GgufValueType::Uint32 | GgufValueType::Int32 | GgufValueType::Float32 => {
            reader.seek(io::SeekFrom::Current((len * 4) as i64))?;
        }
        GgufValueType::Uint64 | GgufValueType::Int64 | GgufValueType::Float64 => {
            reader.seek(io::SeekFrom::Current((len * 8) as i64))?;
        }
        GgufValueType::String => {
            for _ in 0..len {
                let str_len = reader.read_u64::<LittleEndian>()?;
                reader.seek(io::SeekFrom::Current(str_len as i64))?;
            }
        }
        GgufValueType::Array => {
            for _ in 0..len {
                read_gguf_value(reader, elem_type)?;
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
const GGML_TYPE_TQ1_0: u32 = 34;
#[cfg(target_os = "macos")]
const GGML_TYPE_TQ2_0: u32 = 35;
#[cfg(target_os = "macos")]
const MAX_GGUF_TENSOR_COUNT: u64 = 1_000_000;
#[cfg(target_os = "macos")]
const MAX_GGUF_TENSOR_NAME_LEN: u64 = 1024 * 1024;

/// Read only the tensor type ids from a GGUF header without loading tensor data.
#[cfg(target_os = "macos")]
pub fn read_gguf_tensor_types<R: Read + Seek>(reader: R) -> io::Result<HashSet<u32>> {
    let mut file = BufReader::new(reader);

    let mut magic = [0u8; 4];
    file.read_exact(&mut magic)?;
    if &magic != b"GGUF" {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Not a GGUF file"));
    }

    let _version = file.read_u32::<LittleEndian>()?;
    let tensor_count = file.read_u64::<LittleEndian>()?;
    let metadata_count = file.read_u64::<LittleEndian>()?;

    // Skip metadata entries.
    for i in 0..metadata_count {
        read_metadata_entry(&mut file, i)?;
    }

    if tensor_count > MAX_GGUF_TENSOR_COUNT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("tensor count {} exceeds sanity limit", tensor_count),
        ));
    }

    let mut types = HashSet::new();
    for i in 0..tensor_count {
        let name_len = file.read_u64::<LittleEndian>()?;
        if name_len > MAX_GGUF_TENSOR_NAME_LEN {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("tensor {} name length {} is too large", i, name_len),
            ));
        }
        file.seek(io::SeekFrom::Current(name_len as i64))?;

        let n_dims = file.read_u32::<LittleEndian>()?;
        if n_dims > 8 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("tensor {} has too many dimensions ({})", i, n_dims),
            ));
        }
        for _ in 0..n_dims {
            file.read_u64::<LittleEndian>()?;
        }
        let type_id = file.read_u32::<LittleEndian>()?;
        types.insert(type_id);
        // Tensor data offset.
        file.read_u64::<LittleEndian>()?;
    }

    Ok(types)
}

/// Pre-flight check for macOS Metal: ternary quantization types (TQ1_0/TQ2_0)
/// have no Metal matmul kernel, so loading them with GPU layers > 0 will abort
/// during warmup. Reject early with an actionable message instead of crashing.
#[cfg(target_os = "macos")]
pub fn check_metal_quantization_support(path: &str) -> Result<(), LlamacppError> {
    let file = File::open(path).map_err(|e| {
        LlamacppError::new(
            ErrorCode::ModelFileNotFound,
            format!("Failed to open model file for pre-flight check: {}", e),
            None,
        )
    })?;
    let types = read_gguf_tensor_types(file).map_err(|e| {
        LlamacppError::new(
            ErrorCode::ModelFileCorrupt,
            format!("Failed to read GGUF tensor types: {}", e),
            None,
        )
    })?;

    if types.contains(&GGML_TYPE_TQ2_0) {
        return Err(LlamacppError::new(
            ErrorCode::ModelQuantizationNotSupported,
            "quantization type TQ2_0 is not supported by the Metal backend. Set GPU layers to 0 or move the offending tensor to CPU with --override-tensor to load this model.".into(),
            None,
        ));
    }
    if types.contains(&GGML_TYPE_TQ1_0) {
        return Err(LlamacppError::new(
            ErrorCode::ModelQuantizationNotSupported,
            "quantization type TQ1_0 is not supported by the Metal backend. Set GPU layers to 0 or move the offending tensor to CPU with --override-tensor to load this model.".into(),
            None,
        ));
    }
    Ok(())
}
