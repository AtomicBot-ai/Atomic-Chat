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
                // Reached on every ~5s usage poll for a GPU that Vulkan never
                // enumerated, so it must not be logged per tick.
                static LOG_MISSING_ONCE: std::sync::Once = std::sync::Once::new();
                LOG_MISSING_ONCE.call_once(|| {
                    log::warn!("get_usage_amd called without Vulkan info");
                });
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
                    available: true,
                    total_memory: read_mem(&device_path.join("mem_info_vram_total")),
                    used_memory: read_mem(&device_path.join("mem_info_vram_used")),
                    utilization_percent: None,
                    temperature_c: None,
                    power_w: None,
                    power_limit_w: None,
                    clock_graphics_mhz: None,
                    clock_memory_mhz: None,
                });
            }
            Err(format!("GPU not found").into())
        };

        match closure() {
            Ok(usage) => usage,
            Err(e) => {
                // "GPU not found" simply means the sysfs walk matched no
                // `amdgpu` node — an expected state on this host, re-tested
                // every ~5s. Match the Windows branch above and report once.
                static LOG_FAILURE_ONCE: std::sync::Once = std::sync::Once::new();
                LOG_FAILURE_ONCE.call_once(|| {
                    log::warn!(
                        "Failed to get memory usage for AMD GPU {:#x}: {}",
                        device_id,
                        e
                    );
                });
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
                available: true,
                used_memory: used_memory as u64,
                total_memory: self.total_memory,
                utilization_percent: None,
                temperature_c: None,
                power_w: None,
                power_limit_w: None,
                clock_graphics_mhz: None,
                clock_memory_mhz: None,
            },
            None => self.get_usage_unsupported(),
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use libc;
    use libloading::Library;
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

    struct AdlApi {
        _lib: Library,
        create: Adl2MainControlCreate,
        destroy: Adl2MainControlDestroy,
        get_adapter_count: Adl2AdapterNumberOfAdaptersGet,
        get_adapter_info: Adl2AdapterAdapterInfoGet,
        get_adapter_active: Adl2AdapterActiveGet,
        get_dedicated_vram_usage: Adl2AdapterDedicatedVramUsageGet,
    }

    impl AdlApi {
        unsafe fn new() -> Result<Self, Box<dyn std::error::Error>> {
            let lib = Library::new("atiadlxx.dll").or_else(|_| Library::new("atiadlxy.dll"))?;

            let create = *lib.get::<Adl2MainControlCreate>(b"ADL2_Main_Control_Create\0")?;
            let destroy = *lib.get::<Adl2MainControlDestroy>(b"ADL2_Main_Control_Destroy\0")?;
            let get_adapter_count =
                *lib.get::<Adl2AdapterNumberOfAdaptersGet>(b"ADL2_Adapter_NumberOfAdapters_Get\0")?;
            let get_adapter_info =
                *lib.get::<Adl2AdapterAdapterInfoGet>(b"ADL2_Adapter_AdapterInfo_Get\0")?;
            let get_adapter_active =
                *lib.get::<Adl2AdapterActiveGet>(b"ADL2_Adapter_Active_Get\0")?;
            let get_dedicated_vram_usage = *lib.get::<Adl2AdapterDedicatedVramUsageGet>(
                b"ADL2_Adapter_DedicatedVRAMUsage_Get\0",
            )?;

            Ok(Self {
                _lib: lib,
                create,
                destroy,
                get_adapter_count,
                get_adapter_info,
                get_adapter_active,
                get_dedicated_vram_usage,
            })
        }
    }

    struct AdlContext<'a> {
        api: &'a AdlApi,
        handle: *mut c_void,
    }

    impl<'a> Drop for AdlContext<'a> {
        fn drop(&mut self) {
            unsafe {
                let _ = (self.api.destroy)(self.handle);
            }
        }
    }

    impl<'a> AdlContext<'a> {
        fn new(api: &'a AdlApi) -> Result<Self, Box<dyn std::error::Error>> {
            let mut handle = std::ptr::null_mut();
            let status = unsafe { (api.create)(adl_malloc, 1, &mut handle) };
            if status != 0 || handle.is_null() {
                return Err(format!("ADL2 initialization failed with status {status}").into());
            }
            Ok(Self { api, handle })
        }

        fn get_adapter_count(&self) -> Result<c_int, Box<dyn std::error::Error>> {
            let mut num_adapters = 0;
            let status = unsafe { (self.api.get_adapter_count)(self.handle, &mut num_adapters) };
            if status != 0 {
                return Err(format!("ADL2 adapter enumeration failed with status {status}").into());
            }
            Ok(num_adapters)
        }

        fn get_adapter_info(
            &self,
            num_adapters: c_int,
        ) -> Result<Vec<AdapterInfo>, Box<dyn std::error::Error>> {
            let mut adapter_info: Vec<AdapterInfo> =
                vec![unsafe { MaybeUninit::zeroed().assume_init() }; num_adapters as usize];
            let status = unsafe {
                (self.api.get_adapter_info)(
                    self.handle,
                    adapter_info.as_mut_ptr(),
                    mem::size_of::<AdapterInfo>() as i32 * num_adapters,
                )
            };
            if status != 0 {
                return Err(format!("ADL2 adapter info query failed with status {status}").into());
            }
            Ok(adapter_info)
        }

        fn is_adapter_active(&self, adapter_index: c_int) -> Result<bool, String> {
            let mut is_active = 0;
            let status = unsafe {
                (self.api.get_adapter_active)(self.handle, adapter_index, &mut is_active)
            };
            if status != 0 {
                return Err(format!(
                    "ADL2 active-adapter query failed with status {status}"
                ));
            }
            Ok(is_active != 0)
        }

        fn get_dedicated_vram_usage(&self, adapter_index: c_int) -> Result<c_int, String> {
            let mut vram_mb = 0;
            let status = unsafe {
                (self.api.get_dedicated_vram_usage)(self.handle, adapter_index, &mut vram_mb)
            };
            if status != 0 || vram_mb < 0 {
                return Err(format!(
                    "ADL2 dedicated VRAM query returned status {status} and value {vram_mb}"
                ));
            }
            Ok(vram_mb)
        }
    }

    static ADL_LOCK: Mutex<()> = Mutex::new(());

    // === ADL Memory Allocator ===
    unsafe extern "C" fn adl_malloc(i_size: i32) -> *mut c_void {
        libc::malloc(i_size as usize)
    }

    pub fn get_gpu_usage() -> Result<HashMap<String, i32>, Box<dyn std::error::Error>> {
        let _lock = ADL_LOCK.lock().map_err(|_| "AMD ADL lock poisoned")?;

        let api = unsafe { AdlApi::new()? };
        let context = AdlContext::new(&api)?;

        let num_adapters = context.get_adapter_count()?;
        let mut vram_usages = HashMap::new();
        let mut last_probe_error = None;

        if num_adapters > 0 {
            let adapter_info = context.get_adapter_info(num_adapters)?;

            for adapter in adapter_info.iter() {
                match context.is_adapter_active(adapter.iAdapterIndex) {
                    Ok(true) => match context.get_dedicated_vram_usage(adapter.iAdapterIndex) {
                        Ok(vram_mb) => {
                            let name = unsafe {
                                CStr::from_ptr(adapter.strAdapterName.as_ptr())
                                    .to_string_lossy()
                                    .into_owned()
                            };
                            vram_usages.insert(name, vram_mb);
                        }
                        Err(e) => {
                            last_probe_error = Some(e);
                        }
                    },
                    Ok(false) => continue,
                    Err(e) => {
                        last_probe_error = Some(e);
                    }
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
