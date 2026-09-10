//! Microphone capture on a dedicated thread.
//!
//! `cpal::Stream` is `!Send`: it must be built, played and dropped on the same
//! thread, and on Windows that thread needs COM initialised — which cpal does
//! for us when the stream is built there. So the stream never leaves the
//! capture thread, and the outside world talks to it through channels.
//!
//! The data callback is on the audio thread. It copies and hands off, nothing
//! else: no allocation beyond one `Box<[f32]>`, no locks, no blocking send, and
//! absolutely no `unwrap` — the release profile aborts on panic, so a panic
//! here would take the whole app down with no unwind.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    Device, FromSample, Sample, SampleFormat, SizedSample, StreamConfig, SupportedStreamConfig,
};
use serde::Serialize;

use crate::dsp::TARGET_SAMPLE_RATE;
use crate::error::{AudioError, AudioErrorCode, AudioResult};

/// How long the capture thread waits between control-channel polls. Also the
/// worst-case latency for noticing a device error.
const CONTROL_POLL: Duration = Duration::from_millis(100);

/// Capture buffers in flight. Deep enough to ride out a scheduling hiccup,
/// shallow enough that a stalled worker is noticed rather than hidden.
pub const PCM_QUEUE_DEPTH: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputDevice {
    /// Stable, persistable identifier (`cpal::DeviceId` via `Display`).
    pub id: Option<String>,
    pub name: String,
    pub is_default: bool,
    /// True when the device can hand us 16 kHz directly, skipping resampling.
    pub supports_16k: bool,
    pub default_sample_rate: u32,
    pub channels: u16,
}

pub enum ControlMsg {
    Stop,
}

/// What the capture thread reports back once the stream is running.
pub struct CaptureInfo {
    pub device_id: Option<String>,
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub resampled: bool,
    pub fell_back_to_default: bool,
}

pub fn map_cpal_error(err: &cpal::Error) -> AudioError {
    use cpal::ErrorKind;
    let message = err.to_string();
    let code = match err.kind() {
        ErrorKind::PermissionDenied => AudioErrorCode::PermissionDenied,
        ErrorKind::DeviceBusy => AudioErrorCode::DeviceUnavailable,
        ErrorKind::DeviceNotAvailable | ErrorKind::DeviceChanged => {
            AudioErrorCode::DeviceDisconnected
        }
        ErrorKind::HostUnavailable => AudioErrorCode::NoInputDevice,
        _ => AudioErrorCode::DeviceUnavailable,
    };
    AudioError::with_details(code, "The microphone couldn't be used.", message)
}

fn device_label(device: &Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "Unknown microphone".to_string())
}

fn device_identifier(device: &Device) -> Option<String> {
    device.id().ok().map(|id| id.to_string())
}

/// Enumerate input devices. Blocking — ALSA enumeration can take hundreds of ms,
/// so callers run this off the UI path.
pub fn list_devices() -> AudioResult<Vec<AudioInputDevice>> {
    let host = cpal::default_host();
    let default_id = host.default_input_device().and_then(|d| device_identifier(&d));
    let default_name = host.default_input_device().map(|d| device_label(&d));

    let devices = host.input_devices().map_err(|e| map_cpal_error(&e))?;

    let mut out = Vec::new();
    for device in devices {
        let name = device_label(&device);
        let id = device_identifier(&device);
        let config = device.default_input_config().ok();

        let supports_16k = device
            .supported_input_configs()
            .map(|configs| {
                configs.into_iter().any(|range| {
                    range.min_sample_rate() <= TARGET_SAMPLE_RATE
                        && range.max_sample_rate() >= TARGET_SAMPLE_RATE
                })
            })
            .unwrap_or(false);

        let is_default = match (&id, &default_id) {
            (Some(a), Some(b)) => a == b,
            _ => default_name.as_deref() == Some(name.as_str()),
        };

        out.push(AudioInputDevice {
            id,
            name,
            is_default,
            supports_16k,
            default_sample_rate: config.as_ref().map(|c| c.sample_rate()).unwrap_or(0),
            channels: config.as_ref().map(|c| c.channels()).unwrap_or(0),
        });
    }

    Ok(out)
}

/// Resolve the requested device, falling back to the system default.
///
/// Returns the device and whether we had to fall back — the caller surfaces the
/// fallback so a user whose USB mic is unplugged is told why they are suddenly
/// on the built-in one.
fn pick_device(requested: Option<&str>) -> AudioResult<(Device, bool)> {
    let host = cpal::default_host();

    if let Some(wanted) = requested.filter(|s| !s.is_empty()) {
        if let Ok(devices) = host.input_devices() {
            let mut by_name: Option<Device> = None;
            for device in devices {
                if device_identifier(&device).as_deref() == Some(wanted) {
                    return Ok((device, false));
                }
                if by_name.is_none() && device_label(&device).eq_ignore_ascii_case(wanted) {
                    by_name = Some(device);
                }
            }
            if let Some(device) = by_name {
                return Ok((device, false));
            }
        }
        let device = host.default_input_device().ok_or_else(|| {
            AudioError::new(AudioErrorCode::NoInputDevice, "No microphone was found.")
        })?;
        return Ok((device, true));
    }

    let device = host.default_input_device().ok_or_else(|| {
        AudioError::new(AudioErrorCode::NoInputDevice, "No microphone was found.")
    })?;
    Ok((device, false))
}

/// Prefer a native 16 kHz config so no resampling is needed at all — common on
/// WASAPI shared mode and on many ALSA devices.
fn choose_config(device: &Device) -> AudioResult<SupportedStreamConfig> {
    if let Ok(configs) = device.supported_input_configs() {
        let mut best: Option<cpal::SupportedStreamConfigRange> = None;
        for range in configs {
            if range.min_sample_rate() <= TARGET_SAMPLE_RATE
                && range.max_sample_rate() >= TARGET_SAMPLE_RATE
            {
                // Fewest channels wins: mono in means no downmix.
                let better = match &best {
                    Some(current) => range.channels() < current.channels(),
                    None => true,
                };
                if better {
                    best = Some(range);
                }
            }
        }
        if let Some(range) = best {
            return Ok(range.with_sample_rate(TARGET_SAMPLE_RATE));
        }
    }

    device
        .default_input_config()
        .map_err(|e| map_cpal_error(&e))
}

/// Build the stream for whichever sample format the device speaks.
fn build_typed<T>(
    device: &Device,
    config: StreamConfig,
    pcm_tx: SyncSender<Box<[f32]>>,
    dropped: Arc<AtomicU64>,
    err_slot: Arc<Mutex<Option<cpal::Error>>>,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _| {
            // Audio thread. Convert, hand off, return. Nothing that can block
            // or panic.
            let mut buffer = Vec::with_capacity(data.len());
            for sample in data {
                buffer.push(f32::from_sample(*sample));
            }
            if pcm_tx.try_send(buffer.into_boxed_slice()).is_err() {
                // The worker is behind. Dropping a buffer degrades the
                // transcript slightly; blocking here would glitch the whole
                // system's audio.
                dropped.fetch_add(1, Ordering::Relaxed);
            }
        },
        move |err| {
            if let Ok(mut slot) = err_slot.lock() {
                if slot.is_none() {
                    *slot = Some(err);
                }
            }
        },
        None,
    )
}

/// Start capturing.
///
/// Returns once the stream is running, so the caller can report a real device
/// name and sample rate. All errors that happen later arrive through `err_slot`
/// and are noticed within `CONTROL_POLL`.
pub fn spawn_capture(
    requested_device: Option<String>,
    pcm_tx: SyncSender<Box<[f32]>>,
    control_rx: Receiver<ControlMsg>,
    dropped: Arc<AtomicU64>,
    err_slot: Arc<Mutex<Option<cpal::Error>>>,
) -> AudioResult<(CaptureInfo, std::thread::JoinHandle<()>)> {
    let (device, fell_back) = pick_device(requested_device.as_deref())?;
    let supported = choose_config(&device)?;

    let sample_format = supported.sample_format();
    let config = supported.config();
    let sample_rate = config.sample_rate;
    let channels = config.channels;

    let info = CaptureInfo {
        device_id: device_identifier(&device),
        device_name: device_label(&device),
        sample_rate,
        channels,
        resampled: sample_rate != TARGET_SAMPLE_RATE,
        fell_back_to_default: fell_back,
    };

    // The stream is built inside the thread and never escapes it.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), AudioError>>();
    let err_for_thread = Arc::clone(&err_slot);

    let handle = std::thread::Builder::new()
        .name("atomic-audio-capture".into())
        .spawn(move || {
            let built = match sample_format {
                SampleFormat::F32 => {
                    build_typed::<f32>(&device, config, pcm_tx, dropped, err_for_thread)
                }
                SampleFormat::I16 => {
                    build_typed::<i16>(&device, config, pcm_tx, dropped, err_for_thread)
                }
                SampleFormat::U16 => {
                    build_typed::<u16>(&device, config, pcm_tx, dropped, err_for_thread)
                }
                SampleFormat::I32 => {
                    build_typed::<i32>(&device, config, pcm_tx, dropped, err_for_thread)
                }
                SampleFormat::I8 => {
                    build_typed::<i8>(&device, config, pcm_tx, dropped, err_for_thread)
                }
                SampleFormat::U8 => {
                    build_typed::<u8>(&device, config, pcm_tx, dropped, err_for_thread)
                }
                other => {
                    let _ = ready_tx.send(Err(AudioError::with_details(
                        AudioErrorCode::DeviceUnavailable,
                        "This microphone uses an audio format we can't read.",
                        format!("{other:?}"),
                    )));
                    return;
                }
            };

            let stream = match built {
                Ok(stream) => stream,
                Err(err) => {
                    let _ = ready_tx.send(Err(map_cpal_error(&err)));
                    return;
                }
            };

            if let Err(err) = stream.play() {
                let _ = ready_tx.send(Err(map_cpal_error(&err)));
                return;
            }

            let _ = ready_tx.send(Ok(()));

            // Park here until told to stop, or until the error callback fires.
            loop {
                match control_rx.recv_timeout(CONTROL_POLL) {
                    Ok(ControlMsg::Stop) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        let failed = err_slot
                            .lock()
                            .map(|slot| slot.is_some())
                            .unwrap_or(true);
                        if failed {
                            break;
                        }
                    }
                }
            }

            // Dropped on the thread that built it, as cpal requires.
            drop(stream);
        })
        .map_err(|e| {
            AudioError::with_details(
                AudioErrorCode::Internal,
                "The capture thread could not be started.",
                e.to_string(),
            )
        })?;

    match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(())) => Ok((info, handle)),
        Ok(Err(err)) => Err(err),
        Err(_) => Err(AudioError::new(
            AudioErrorCode::DeviceUnavailable,
            "The microphone did not start in time.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumerating_devices_never_panics() {
        // On a headless CI box this legitimately returns an empty list or an
        // error; what matters is that it does not abort the process.
        let _ = list_devices();
    }

    #[test]
    fn cpal_errors_map_onto_actionable_codes() {
        use cpal::{Error, ErrorKind};

        assert_eq!(
            map_cpal_error(&Error::new(ErrorKind::PermissionDenied)).code,
            AudioErrorCode::PermissionDenied
        );
        assert_eq!(
            map_cpal_error(&Error::new(ErrorKind::DeviceBusy)).code,
            AudioErrorCode::DeviceUnavailable
        );
        assert_eq!(
            map_cpal_error(&Error::new(ErrorKind::DeviceNotAvailable)).code,
            AudioErrorCode::DeviceDisconnected
        );
        assert_eq!(
            map_cpal_error(&Error::new(ErrorKind::HostUnavailable)).code,
            AudioErrorCode::NoInputDevice
        );
    }
}
