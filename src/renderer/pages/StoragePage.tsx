import { StoragePanel } from '../components/StoragePanel'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'

export function StoragePage(): React.JSX.Element {
  return (
    <Page width="default">
      <PageHeader title="Storage" description="See how much disk space each job uses. Delete kept streams to free space; rendered clips stay." />
      <div className="mt-4">
        <StoragePanel />
      </div>
    </Page>
  )
}
