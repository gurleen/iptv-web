import type { Game } from '@/lib/api'
import { cn } from '@/lib/utils'

type Side = Game['home']

function TeamLine({ side, showScore, dim }: { side: Side; showScore: boolean; dim: boolean }) {
  return (
    <div className={cn('flex items-center gap-1.5', dim && 'opacity-60')}>
      {side.team.logo ? <img src={side.team.logo} alt="" className="size-4 shrink-0 object-contain" loading="lazy" /> : <span className="size-4 shrink-0" />}
      {side.rank != null && <span className="text-[10px] text-muted-foreground">#{side.rank}</span>}
      <span className="truncate font-medium">{side.team.shortName ?? side.team.displayName}</span>
      {!showScore && side.record && <span className="text-xs text-muted-foreground">{side.record}</span>}
      {showScore && <span className="ml-auto pl-2 font-semibold tabular-nums">{side.score ?? '–'}</span>}
    </div>
  )
}

/** Compact matchup: logos, records (before) or scores (during/after), status, TV. */
export function GameChip({ game, className }: { game: Game; className?: string }) {
  const showScore = game.status.state !== 'pre'
  const loser = (s: Side) => game.status.completed && s.winner === false
  return (
    <div className={cn('inline-flex min-w-0 flex-col gap-0.5 rounded-md border bg-muted/30 px-2 py-1 text-xs', className)}>
      <TeamLine side={game.away} showScore={showScore} dim={loser(game.away)} />
      <TeamLine side={game.home} showScore={showScore} dim={loser(game.home)} />
      <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
        {game.status.state === 'in' && <span className="font-semibold text-red-500">LIVE</span>}
        <span>{game.status.state === 'pre' ? (game.odds?.details ?? 'Scheduled') : game.status.shortDetail}</span>
        {game.broadcasts.length > 0 && <span>· {game.broadcasts.slice(0, 2).join(', ')}</span>}
      </div>
    </div>
  )
}
