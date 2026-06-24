export const dynamic = 'force-dynamic'

import AppShell from './shell'

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
