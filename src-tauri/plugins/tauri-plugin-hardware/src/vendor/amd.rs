use crate::types::{GpuInfo, GpuUsage};

impl GpuInfo {
    #[cfg(not(target_os = "linux"))]
    #[cfg(not(target_os = "windows"))]
    pub fn get_usage_amd(&self) -> GpuUsage {
        self.get_usage_unsupported()
    }

    #[cfg(target_os = "linux")]
    pub fn get_usage_amd(&self) -> GpuUsage {
        use std::fs;
        use std::path::Path;

        let device_id = match &self.vulkan_info {
            Some(vulkan_info) => vulkan_info.device_id,
            None => {
                log::error!("get_usage_amd called without Vulkan info");
                return self.get_usage_unsupported();
            }
        };

        let closure = || -> Result<GpuUsage, Box<dyn std::error::Error>> {
            for subdir in fs::read_dir("/sys/class/drm")? {
                let device_path = subdir?.path().join("device");

                // Check if this is an AMD GPU by looking for amdgpu directory
                if !device_path
                    .join("driver/module/drivers/pci:amdgpu")
                    .exists()
                {
                    continue;
                }

                // match device_id from Vulkan info
                let this_device_id_str = fs::read_to_string(device_path.join("device"))?;
                let this_device_id = u32::from_str_radix(
                    this_device_id_str
                        .strip_prefix("0x")
                        .unwrap_or(&this_device_id_str)
                        .trim(),
                    16,
                )?;
                if this_device_id != device_id {
                    continue;
                }

                let read_mem = |path: &Path| -> u64 {
                    fs::read_to_string(path)
                        .map(|content| content.trim().parse::<u64>().unwrap_or(0))
                        .unwrap_or(0)
                        / 1024
                        / 1024 // Convert bytes to MiB
                };
                return Ok(GpuUsage {
                    uuid: self.uuid.clone(),
                    total_memory: read_mem(&device_path.join("mem_info_vram_total")),
                    used_memory: read_mem(&device_path.join("mem_info_vram_used")),
                });
            }
            Err(format!("GPU not found").into())
        };

        match closure() {
            Ok(usage) => usage,
            Err(e) => {
                log::error!(
                    "Failed to get memory usage for AMD GPU {:#x}: {}",
                    device_id,
                    e
                );
                self.get_usage_unsupported()
            }
        }
    }

    #[cfg(target_os = "windows")]
    pub fn get_usage_amd(&self) -> GpuUsage {
        use std::collections::HashMap;
        use std::sync::Once;

        let memory_usage_map = windows_impl::get_gpu_usage().unwrap_or_else(|error| {
            static LOG_FAILURE_ONCE: Once = Once::new();
            LOG_FAILURE_ONCE.call_once(|| {
                log::debug!("Failed to get AMD GPU memory usage: {error}");
            });
            HashMap::new()
        });

        match memory_usage_map.get(&self.name) {
            Some(&used_memory) => GpuUsage {
                uuid: self.uuid.clone(),
                used_memory: used_memory as u64,
                total_memory: self.total_memory,
            },
            None => self.get_usage_unsupported(),
        }
    }
}

// TODO: refactor this into a more egonomic API
#[cfg(target_os = "windows")]
mod windows_impl {
    use libc;
    use libloading::{Library, Symbol};
    use std::collections::HashMap;
    use std::ffi::{c_char, c_int, c_void, CStr};
    use std::mem::{self, MaybeUninit};
    use std::sync::Mutex;

    // === FFI Struct Definitions ===
    #[repr(C)]
    #[allow(non_snake_case)]
    #[derive(Debug, Copy, Clone)]
    pub struct AdapterInfo {
        pub iSize: c_int,
        pub iAdapterIndex: c_int,
        pub strUDID: [c_char; 256],
        pub iBusNumber: c_int,
        pub iDeviceNumber: c_int,
        pub iFunctionNumber: c_int,
        pub iVendorID: c_int,
        pub strAdapterName: [c_char; 256],
        pub strDisplayName: [c_char; 256],
        pub iPresent: c_int,
        pub iExist: c_int,
        pub strDriverPath: [c_char; 256],
        pub strDriverPathExt: [c_char; 256],
        pub strPNPString: [c_char; 256],
        pub iOSDisplayIndex: c_int,
    }

    type AdlMainMallocCallback = unsafe extern "C" fn(i32) -> *mut c_void;
    type Adl2MainControlCreate =
        unsafe extern "C" fn(AdlMainMallocCallback, c_int, *mut *mut c_void) -> c_int;
    type Adl2MainControlDestroy = unsafe extern "C" fn(*mut c_void) -> c_int;
    type Adl2AdapterNumberOfAdaptersGet = unsafe extern "C" fn(*mut c_void, *mut c_int) -> c_int;
    type Adl2AdapterAdapterInfoGet =
        unsafe extern "C" fn(*mut c_void, *mut AdapterInfo, c_int) -> c_int;
    type Adl2AdapterActiveGet = unsafe extern "C" fn(*mut c_void, c_int, *mut c_int) -> c_int;
    type Adl2AdapterDedicatedVramUsageGet =
        unsafe extern "C" fn(*mut c_void, c_int, *mut c_int) -> c_int;

    struct AdlContext {
        handle: *mut c_void,
        destroy: Adl2MainControlDestroy,
    }

    impl Drop for AdlContext {
        fn drop(&mut self) {
            unsafe {
                let _ = (self.destroy)(self.handle);
            }
        }
    }

    static ADL_LOCK: Mutex<()> = Mutex::new(());

    // === ADL Memory Allocator ===
    unsafe extern "C" fn adl_malloc(i_size: i32) -> *mut c_void {
        libc::malloc(i_size as usize)
    }

    pub fn get_gpu_usage() -> Result<HashMap<String, i32>, Box<dyn std::error::Error>> {
        let _lock = ADL_LOCK.lock().map_err(|_| "AMD ADL lock poisoned")?;

        unsafe {
            let lib = Library::new("atiadlxx.dll").or_else(|_| Library::new("atiadlxy.dll"))?;

            let create: Symbol<Adl2MainControlCreate> = lib.get(b"ADL2_Main_Control_Create\0")?;
            let destroy: Symbol<Adl2MainControlDestroy> =
                lib.get(b"ADL2_Main_Control_Destroy\0")?;
            let get_adapter_count: Symbol<Adl2AdapterNumberOfAdaptersGet> =
                lib.get(b"ADL2_Adapter_NumberOfAdapters_Get\0")?;
            let get_adapter_info: Symbol<Adl2AdapterAdapterInfoGet> =
                lib.get(b"ADL2_Adapter_AdapterInfo_Get\0")?;
            let get_adapter_active: Symbol<Adl2AdapterActiveGet> =
                lib.get(b"ADL2_Adapter_Active_Get\0")?;
            let get_dedicated_vram_usage: Symbol<Adl2AdapterDedicatedVramUsageGet> =
                lib.get(b"ADL2_Adapter_DedicatedVRAMUsage_Get\0")?;

            let mut context = std::ptr::null_mut();
            let status = create(adl_malloc, 1, &mut context);
            if status != 0 || context.is_null() {
                return Err(format!("ADL2 initialization failed with status {status}").into());
            }
            let context = AdlContext {
                handle: context,
                destroy: *destroy,
            };

            let mut num_adapters: c_int = 0;
            let status = get_adapter_count(context.handle, &mut num_adapters);
            if status != 0 {
                return Err(format!("ADL2 adapter enumeration failed with status {status}").into());
            }

            let mut vram_usages = HashMap::new();
            let mut last_probe_error = None;

            if num_adapters > 0 {
                let mut adapter_info: Vec<AdapterInfo> =
                    vec![MaybeUninit::zeroed().assume_init(); num_adapters as usize];
                let status = get_adapter_info(
                    context.handle,
                    adapter_info.as_mut_ptr(),
                    mem::size_of::<AdapterInfo>() as i32 * num_adapters,
                );
                if status != 0 {
                    return Err(
                        format!("ADL2 adapter info query failed with status {status}").into(),
                    );
                }

                for adapter in adapter_info.iter() {
                    let mut is_active = 0;
                    let status =
                        get_adapter_active(context.handle, adapter.iAdapterIndex, &mut is_active);
                    if status != 0 {
                        last_probe_error = Some(format!(
                            "ADL2 active-adapter query failed with status {status}"
                        ));
                        continue;
                    }

                    if is_active != 0 {
                        let mut vram_mb = 0;
                        let status = get_dedicated_vram_usage(
                            context.handle,
                            adapter.iAdapterIndex,
                            &mut vram_mb,
                        );
                        if status != 0 || vram_mb < 0 {
                            last_probe_error = Some(format!(
                                "ADL2 dedicated VRAM query returned status {status} and value {vram_mb}"
                            ));
                            continue;
                        }
                        // NOTE: adapter name might not be unique?
                        let name = CStr::from_ptr(adapter.strAdapterName.as_ptr())
                            .to_string_lossy()
                            .into_owned();
                        vram_usages.insert(name, vram_mb);
                    }
                }
            }

            if vram_usages.is_empty() {
                if let Some(error) = last_probe_error {
                    return Err(error.into());
                }
            }

            Ok(vram_usages)
        }
    }
}
