import { Segmented } from './ui/Segmented'
import type { Page } from './Sidebar'

/** Settings and the social accounts, both under Settings in the sidebar. */
export function SettingsTabs({ current, onNavigate }: { current: 'settings' | 'accounts'; onNavigate: (page: Page) => void }): React.JSX.Element {
  return (
    <Segmented<'settings' | 'accounts'>
      label="Settings"
      size="sm"
      value={current}
      onChange={onNavigate}
      options={[{ value: 'settings', label: 'General' }, { value: 'accounts', label: 'Accounts' }]}
    />
  )
}
