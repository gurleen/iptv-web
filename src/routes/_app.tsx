import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, createFileRoute, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  CalendarClock,
  Database,
  LayoutDashboard,
  LayoutGrid,
  ListVideo,
  LogOut,
  Menu,
  Moon,
  Newspaper,
  Search,
  Settings,
  Sun,
  Tv,
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { api } from '@/lib/api'

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

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-1 flex-col gap-0.5">
      {NAV.map((n) => (
        <Link
          key={n.to}
          to={n.to}
          onClick={onNavigate}
          activeOptions={{ exact: n.to === '/' }}
          className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground md:py-1.5"
          activeProps={{ className: 'bg-accent text-foreground font-medium' }}
        >
          <n.icon className="size-4" /> {n.label}
        </Link>
      ))}
    </nav>
  )
}

function FooterButtons() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  return (
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
  )
}

function AppLayout() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/auth/me') })
  const [menuOpen, setMenuOpen] = useState(false)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const current = NAV.find((n) => (n.to === '/' ? pathname === '/' : pathname.startsWith(n.to)))

  if (me.isPending) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r bg-muted/30 p-3 md:flex">
        <div className="mb-4 flex items-center gap-2 px-2 py-1 font-semibold">
          <Tv className="size-5" /> IPTV Web
        </div>
        <NavLinks />
        <FooterButtons />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* phone header */}
        <header className="sticky top-0 z-40 flex h-12 items-center gap-2 border-b bg-background/95 px-2 backdrop-blur md:hidden">
          <Button variant="ghost" size="icon" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            <Menu />
          </Button>
          <Tv className="size-4" />
          <span className="font-semibold">IPTV Web</span>
          {current && <span className="truncate text-sm text-muted-foreground">· {current.label}</span>}
        </header>
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent side="left" className="flex w-64 flex-col gap-4 p-3">
            <SheetTitle className="flex items-center gap-2 px-2 pt-2">
              <Tv className="size-5" /> IPTV Web
            </SheetTitle>
            <NavLinks onNavigate={() => setMenuOpen(false)} />
            <FooterButtons />
          </SheetContent>
        </Sheet>

        <main className="mx-auto w-full max-w-7xl min-w-0 flex-1 p-4 md:p-6">
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
