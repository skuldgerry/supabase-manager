import { useParams } from 'common'
import { useQuery } from '@tanstack/react-query'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns'

import { PocketBaseProjectPanel } from '@/components/interfaces/SelfHosted/PocketBaseProjectPanel'
import { PocketBaseMigratePanel } from '@/components/interfaces/SelfHosted/PocketBaseMigratePanel'
import DefaultLayout from '@/components/layouts/DefaultLayout'
import SettingsLayout from '@/components/layouts/ProjectSettingsLayout/SettingsLayout'
import type { NextPageWithLayout } from '@/types'

interface PBProject {
  ref: string
  name: string
  public_url: string
  creation_mode: string
  pocketbase_admin_email: string
  pocketbase_admin_password: string
  pocketbase_port: number
}

const PocketBaseSettingsPage: NextPageWithLayout = () => {
  const { ref } = useParams() as { ref: string }

  const { data: project, isLoading } = useQuery<PBProject>({
    queryKey: ['pb-project-detail', ref],
    queryFn: async () => {
      const res = await fetch(`/api/platform/projects/${ref}`)
      if (!res.ok) throw new Error('Failed to load project')
      return res.json()
    },
    enabled: !!ref,
    staleTime: 30_000,
  })
  const isPocketBase = project?.creation_mode === 'pocketbase' || project?.creation_mode === 'pocketbase-embedded'

  return (
    <>
      <PageHeader size="small">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{isPocketBase ? 'PocketBase' : 'Data Migration'}</PageHeaderTitle>
            <PageHeaderDescription>
              Migrate collections and records between authorized PocketBase and Supabase projects.
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>

      <PageContainer size="small">
        {isPocketBase && <PageSection>
          <PageSectionMeta>
            <PageSectionSummary>
              <PageSectionTitle>Admin Access</PageSectionTitle>
              <PageSectionDescription>
                Connect to your PocketBase instance and manage collections.
              </PageSectionDescription>
            </PageSectionSummary>
          </PageSectionMeta>
          <PageSectionContent>
            {isLoading ? (
              <GenericSkeletonLoader />
            ) : project?.pocketbase_admin_email ? (
              <PocketBaseProjectPanel
                adminEmail={project.pocketbase_admin_email}
                adminPassword={project.pocketbase_admin_password}
                publicUrl={project.public_url}
              />
            ) : (
              <p className="text-sm text-foreground-muted">
                Admin credentials not available. This may not be a PocketBase project.
              </p>
            )}
          </PageSectionContent>
        </PageSection>}

        {!isLoading && (
          <PageSection>
            <PageSectionMeta>
              <PageSectionSummary>
                <PageSectionTitle>Data Migration</PageSectionTitle>
                <PageSectionDescription>
                  Choose the Supabase project and PocketBase endpoint. Manager permission is required for both endpoints.
                </PageSectionDescription>
              </PageSectionSummary>
            </PageSectionMeta>
            <PageSectionContent>
              <PocketBaseMigratePanel supaRef={ref} />
            </PageSectionContent>
          </PageSection>
        )}
      </PageContainer>
    </>
  )
}

PocketBaseSettingsPage.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title="PocketBase">{page}</SettingsLayout>
  </DefaultLayout>
)

export default PocketBaseSettingsPage
