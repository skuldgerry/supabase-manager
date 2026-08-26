import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { DesiredInstanceSize, PostgresEngine, ReleaseChannel } from './new-project.constants'
import { useInvalidateProjectsInfiniteQuery } from './org-projects-infinite-query'
import type { components } from '@/data/api'
import { handleError, post } from '@/data/fetchers'
import { PROVIDERS } from '@/lib/constants'
import { captureCriticalError } from '@/lib/error-reporting'
import type { ResponseError, UseCustomMutationOptions } from '@/types'

type CreateProjectBody = components['schemas']['CreateProjectBody']
type CloudProvider = CreateProjectBody['cloud_provider']

export type ProjectCreateVariables = {
  name: string
  organizationSlug: string
  dbPass: string
  dbRegion?: string
  regionSelection?: CreateProjectBody['region_selection']
  dbSql?: string
  dbPricingTierId?: string
  cloudProvider?: string
  authSiteUrl?: string
  customSupabaseRequest?: object
  dbInstanceSize?: DesiredInstanceSize
  dataApiExposedSchemas?: string[]
  dataApiUseApiSchema?: boolean
  postgresEngine?: PostgresEngine
  releaseChannel?: ReleaseChannel
  highAvailability?: boolean
  selfHosted?: {
    creation_mode: 'stack'
    stack_release?: string
    public_url?: string
    site_url?: string
    ports?: { api: number; dbSession: number; dbTransaction: number }
    dashboard_username?: string
    custom_credentials?: { postgresPassword: string; dashboardPassword: string; jwtSecret: string }
  }
}

export async function createProject({
  name,
  organizationSlug,
  dbPass,
  dbRegion,
  regionSelection,
  dbSql,
  cloudProvider = PROVIDERS.AWS.id,
  authSiteUrl,
  customSupabaseRequest,
  dbInstanceSize,
  dataApiExposedSchemas,
  dataApiUseApiSchema,
  postgresEngine,
  releaseChannel,
  highAvailability,
  selfHosted,
}: ProjectCreateVariables) {
  const body: CreateProjectBody & Record<string, unknown> = {
    cloud_provider: cloudProvider as CloudProvider,
    organization_slug: organizationSlug,
    name,
    db_pass: dbPass,
    db_region: dbRegion,
    region_selection: regionSelection,
    db_sql: dbSql,
    auth_site_url: authSiteUrl,
    ...(customSupabaseRequest !== undefined && {
      custom_supabase_internal_requests: customSupabaseRequest as any,
    }),
    desired_instance_size: dbInstanceSize,
    data_api_exposed_schemas: dataApiExposedSchemas,
    data_api_use_api_schema: dataApiUseApiSchema,
    postgres_engine: postgresEngine,
    release_channel: releaseChannel,
    high_availability: highAvailability,
    ...(selfHosted && {
      creation_mode: selfHosted.creation_mode,
      stack_release: selfHosted.stack_release,
      public_url: selfHosted.public_url,
      site_url: selfHosted.site_url,
      ports: selfHosted.ports,
      dashboard_username: selfHosted.dashboard_username,
      custom_credentials: selfHosted.custom_credentials,
    }),
  }

  const { data, error } = await post(`/platform/projects`, {
    body,
  })

  if (error) handleError(error)
  return data
}

type ProjectCreateData = Awaited<ReturnType<typeof createProject>>

export const useProjectCreateMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<ProjectCreateData, ResponseError, ProjectCreateVariables>,
  'mutationFn'
> = {}) => {
  const { invalidateProjectsQuery } = useInvalidateProjectsInfiniteQuery()

  return useMutation<ProjectCreateData, ResponseError, ProjectCreateVariables>({
    mutationFn: (vars) => createProject(vars),
    async onSuccess(data, variables, context) {
      await invalidateProjectsQuery()
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to create new project: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
      captureCriticalError(data, 'create project')
    },
    ...options,
  })
}
