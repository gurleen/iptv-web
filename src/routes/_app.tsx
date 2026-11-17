import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, createFileRoute, useNavigate } from '@tanstack/react-router'
import { CalendarClock, Database, LayoutDashboard, LayoutGrid, ListVideo, LogOut, Moon, Newspaper, Search, Settings, Sun, Tv } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app')({ component: AppLayout, ssr: false })

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/lineup', label: 'Lineup', icon: ListVideo },
  { to: '/guide', label: 'Guide', icon: LayoutGrid },
  { to: '/browse', label: 'Browse sources', icon: Search },
  { to: '/events', label: 'Events', icon: CalendarClock },
  { to: '/sources', label: 'Sources', icon: Database },
  { to: '/epg', label: 'EPG', icon: Newspaper },
  { to: '/settings', label: 'Settings', icon: Settings },
] as const

function AppLayout() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/auth/me') })
  const navigate = useNavigate()
  const qc = useQueryClient()

  if (me.isPending) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r bg-muted/30 p-3 md:flex">
        <div className="mb-4 flex items-center gap-2 px-2 py-1 font-semibold">
          <Tv className="size-5" /> IPTV Web
        </div>
        <nav className="flex flex-1 flex-col gap-0.5">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.to === '/' }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              activeProps={{ className: 'bg-accent text-foreground font-medium' }}
            >
              <n.icon className="size-4" /> {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" title="Toggle theme" onClick={toggleTheme}>
            <Sun className="hidden size-4 dark:block" />
            <Moon className="size-4 dark:hidden" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Log out"
            onClick={async () => {
              await api('/auth/logout', { method: 'POST' })
              qc.clear()
              navigate({ to: '/login', search: { next: undefined } })
            }}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav className="flex gap-1 overflow-x-auto border-b p-2 md:hidden">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.to === '/' }}
              className={cn('flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground')}
              activeProps={{ className: 'bg-accent text-foreground' }}
            >
              <n.icon className="size-3.5" /> {n.label}
            </Link>
          ))}
        </nav>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark')
  try {
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  } catch {}
}
