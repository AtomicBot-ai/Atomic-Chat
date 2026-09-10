export type AutostartPreference = 'pending_default_on' | 'unmanaged' | 'enabled' | 'disabled'

export type AppConfiguration = {
  data_folder: string
  quick_ask: boolean
  distinct_id?: string
  autostart_preference?: AutostartPreference
}
