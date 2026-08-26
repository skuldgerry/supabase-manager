import { LOCAL_STORAGE_KEYS } from 'common'
import Head from 'next/head'
import { useRouter } from 'next/router'
import type { PropsWithChildren } from 'react'
import { useEffect, useLayoutEffect, useMemo } from 'react'
import { cn } from 'ui'

import { useMobileSheet } from '../Navigation/NavigationBar/MobileSheetContext'
import { AccountMenuContent } from './AccountMenuContent'
import { WithSidebar } from './WithSidebar'
import { useCustomContent } from '@/hooks/custom-content/useCustomContent'
import { useIsFeatureEnabled } from '@/hooks/misc/useIsFeatureEnabled'
import { useLocalStorageQuery } from '@/hooks/misc/useLocalStorage'
import { withAuth } from '@/hooks/misc/withAuth'
import { IS_PLATFORM } from '@/lib/constants'
import { buildStudioPageTitle } from '@/lib/page-title'
import { useAppStateSnapshot } from '@/state/app-state'

export interface AccountLayoutProps {
  title: string
}

const AccountLayout = ({ children, title }: PropsWithChildren<AccountLayoutProps>) => {
  const router = useRouter()
  const appSnap = useAppStateSnapshot()
  const { setContent: setMobileSheetContent, registerOpenMenu } = useMobileSheet()
  const currentPath = router.pathname
  const managerAuth = process.env.NEXT_PUBLIC_STUDIO_AUTH === 'manager'

  const showSecuritySettings = useIsFeatureEnabled('account:show_security_settings')

  const { appTitle } = useCustomContent(['app:title'])
  const brandTitle = appTitle || 'Supabase'
  const surfaceLabel = IS_PLATFORM ? 'Account' : 'Preferences'

  const [lastVisitedOrganization] = useLocalStorageQuery(
    LOCAL_STORAGE_KEYS.LAST_VISITED_ORGANIZATION,
    ''
  )

  const backToDashboardURL =
    appSnap.lastRouteBeforeVisitingAccountPage.length > 0
      ? appSnap.lastRouteBeforeVisitingAccountPage
      : IS_PLATFORM && !!lastVisitedOrganization
        ? `/org/${lastVisitedOrganization}`
        : IS_PLATFORM
          ? '/organizations'
          : '/projects'

  const pageTitle = buildStudioPageTitle({
    section: title,
    surface: surfaceLabel,
    brand: brandTitle,
  })

  const sections = useMemo(
    () =>
      !IS_PLATFORM && !managerAuth
        ? [
            {
              key: 'preferences',
              links: [
                {
                  key: 'preferences',
                  label: 'Preferences',
                  href: '/account/me',
                  isActive: currentPath === '/account/me',
                },
              ],
            },
          ]
        : [
            {
              key: 'account-settings',
              heading: 'Account Settings',
              links: [
                {
                  key: 'preferences',
                  label: 'Preferences',
                  href: '/account/me',
                  isActive: currentPath === '/account/me',
                },
                ...(IS_PLATFORM
                  ? [
                      {
                        key: 'access-tokens',
                        label: 'Access Tokens',
                        href: '/account/tokens',
                        isActive:
                          currentPath === '/account/tokens' ||
                          currentPath === '/account/tokens/scoped',
                      },
                    ]
                  : []),
                ...(managerAuth || showSecuritySettings
                  ? [
                      {
                        key: 'security',
                        label: 'Security',
                        href: '/account/security',
                        isActive: currentPath === '/account/security',
                      },
                    ]
                  : []),
              ],
            },
            ...(IS_PLATFORM
              ? [
                  {
                    key: 'logs',
                    heading: 'Logs',
                    links: [
                      {
                        key: 'audit-logs',
                        label: 'Audit Logs',
                        href: '/account/audit',
                        isActive: currentPath === '/account/audit',
                      },
                    ],
                  },
                ]
              : []),
          ],
    [currentPath, managerAuth, showSecuritySettings]
  )

  useLayoutEffect(() => {
    const unregister = registerOpenMenu(() => {
      setMobileSheetContent(
        <AccountMenuContent sections={sections} onCloseSheet={() => setMobileSheetContent(null)} />
      )
    })
    return unregister
  }, [registerOpenMenu, setMobileSheetContent, sections])

  useEffect(() => {
    const isSupportedSelfHostedPath =
      currentPath === '/account/me' || (managerAuth && currentPath === '/account/security')

    if (!IS_PLATFORM && !isSupportedSelfHostedPath) {
      router.push('/projects')
    }
  }, [currentPath, managerAuth, router])

  return (
    <>
      <Head>
        <title>{pageTitle}</title>
        <meta name="description" content="Supabase Studio" />
      </Head>
      <div className={cn('flex flex-col w-screen h-[calc(100vh-48px)]')}>
        <WithSidebar
          title=""
          breadcrumbs={[]}
          backToDashboardURL={backToDashboardURL}
          sections={sections}
        >
          {children}
        </WithSidebar>
      </div>
    </>
  )
}

export default withAuth(AccountLayout)
