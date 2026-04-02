import { useState, useEffect, useMemo } from 'react'
import './App.css'

// ─── Constants ────────────────────────────────────────────────────────────────

const ET_TZ = 'America/New_York'

// Peak = 13:00–19:00 UTC, weekdays only
// (= 9–15 EDT / 8–14 EST / 18:30–00:30 IST / 14–20 BST …)
const PEAK_START_UTC = 13
const PEAK_END_UTC   = 19

const BOOT_SEQUENCE = [
  '> CLAUDE_PEAK_MONITOR v2.0 — BOOT SEQUENCE STARTED',
  '> LOADING TIMEZONE MODULE .................... [OK]',
  '> SYNCING PEAK SCHEDULE ...................... [OK]',
  '> RUNNING STATUS CHECK ....................... [OK]',
  '> INITIALIZING MONITORING DAEMON ............. [OK]',
  '',
  '> ALL SYSTEMS NOMINAL. DISPLAY ACTIVE.',
]

// ─── Core logic ───────────────────────────────────────────────────────────────

function isPeak(d: Date): boolean {
  const dow = d.getUTCDay()              // 0=Sun … 6=Sat
  if (dow === 0 || dow === 6) return false
  const h = d.getUTCHours()
  return h >= PEAK_START_UTC && h < PEAK_END_UTC
}

/**
 * Binary-search for exact ms of next (forward) or last (!forward) status transition.
 * Uses 90 × 1-hour steps so it covers the worst-case ~66 h Fri-19:00 → Mon-13:00 UTC gap.
 */
function findTransition(from: Date, forward: boolean): Date {
  const cur = isPeak(from)
  const step = forward ? 3_600_000 : -3_600_000

  let probe = new Date(from.getTime() + step)
  for (let i = 0; i < 90; i++) {
    if (isPeak(probe) !== cur) break
    probe = new Date(probe.getTime() + step)
  }

  let lo = forward ? from.getTime() : probe.getTime()
  let hi = forward ? probe.getTime() : from.getTime()

  while (hi - lo > 1_000) {
    const mid = Math.floor((lo + hi) / 2)
    if (isPeak(new Date(mid)) === cur) {
      if (forward) lo = mid; else hi = mid
    } else {
      if (forward) hi = mid; else lo = mid
    }
  }
  return new Date(hi)
}

function localTZ(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

function fmtTime(d: Date, tz: string): string {
  return d.toLocaleTimeString('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

function fmtETOffset(): string {
  const etStr = new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TZ, timeZoneName: 'short',
  }).formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value ?? 'ET'
  return etStr
}

function msToHMS(ms: number): [string, string, string] {
  const t = Math.max(0, Math.floor(ms / 1000))
  return [
    String(Math.floor(t / 3600)).padStart(2, '0'),
    String(Math.floor((t % 3600) / 60)).padStart(2, '0'),
    String(t % 60).padStart(2, '0'),
  ]
}

// ─── 7-day grid ───────────────────────────────────────────────────────────────

interface HourCell {
  hour: number; peak: boolean; past: boolean; current: boolean;
  splitFrac?: number;    // 0–1: fraction of the cell where first color ends
  splitToPeak?: boolean; // true = left=off-peak → right=peak
}
interface DayRow {
  label: string; today: boolean; weekend: boolean; hours: HourCell[];
}

function build7Days(now: Date): DayRow[] {
  const tz = localTZ()
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)

  return Array.from({ length: 7 }, (_, d) => {
    const dayMs = midnight.getTime() + d * 86_400_000

    const label = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    }).format(new Date(dayMs))

    // Treat the day as weekend if UTC-noon of that local day falls on Sat/Sun
    const noonUtcDow = new Date(dayMs + 12 * 3_600_000).getUTCDay()
    const weekend = noonUtcDow === 0 || noonUtcDow === 6

    const hours: HourCell[] = Array.from({ length: 24 }, (_, h) => {
      const t = dayMs + h * 3_600_000
      const startPeak = isPeak(new Date(t))
      const endPeak   = isPeak(new Date(t + 3_599_000))

      let splitFrac: number | undefined
      let splitToPeak: boolean | undefined
      if (startPeak !== endPeak) {
        // Binary-search the transition to the nearest minute
        let lo = t, hi = t + 3_600_000
        while (hi - lo > 60_000) {
          const mid = Math.floor((lo + hi) / 2)
          if (isPeak(new Date(mid)) === startPeak) lo = mid; else hi = mid
        }
        splitFrac    = (hi - t) / 3_600_000
        splitToPeak  = !startPeak
      }

      return {
        hour: h,
        peak: endPeak,
        past: t + 3_600_000 <= now.getTime(),
        current: t <= now.getTime() && now.getTime() < t + 3_600_000,
        splitFrac,
        splitToPeak,
      }
    })
    return { label, today: d === 0, weekend, hours }
  })
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function BootScreen({ onDone }: { onDone: () => void }) {
  const [lines, setLines] = useState(0)

  useEffect(() => {
    const id = setInterval(() => {
      setLines(l => {
        const next = l + 1
        if (next >= BOOT_SEQUENCE.length) {
          clearInterval(id)
          setTimeout(onDone, 500)
        }
        return next
      })
    }, 260)
    return () => clearInterval(id)
  }, [onDone])

  return (
    <div className="boot">
      <div className="boot-lines">
        {BOOT_SEQUENCE.slice(0, lines).map((line, i) => (
          <div key={i} className="boot-line done">{line || '\u00A0'}</div>
        ))}
        {lines < BOOT_SEQUENCE.length && (
          <div className="boot-line active">
            {BOOT_SEQUENCE[lines] || '\u00A0'}
            <span className="cursor-blink">█</span>
          </div>
        )}
      </div>
    </div>
  )
}

function HeatmapGrid({ days }: { days: DayRow[] }) {
  const hours = Array.from({ length: 24 }, (_, h) => h)

  return (
    <section className="heatmap-section">
      <div className="section-title">
        7-DAY SCHEDULE
        <span className="title-sub"> · PEAK = 13:00–19:00 UTC · WEEKDAYS ONLY · 2× DRAIN</span>
      </div>

      <div className="hm-legend">
        <span className="hml-peak">█ PEAK (2×)</span>
        <span className="hml-off">▒ OFF-PEAK (1×)</span>
        <span className="hml-past">░ PAST</span>
        <span className="hml-now">▌ NOW</span>
        <span className="hml-split">▒ TRANSITION</span>
        <span className="hml-wkd">· WEEKEND</span>
      </div>

      <div className="hm-grid">
        {/* Hour header */}
        <div className="hm-row hm-header">
          <div className="hm-label" />
          {hours.map(h => (
            <div key={h} className={`hm-hdrcell ${h % 6 === 0 ? 'hm-major' : ''}`}>
              {h % 6 === 0 ? String(h).padStart(2, '0') : ''}
            </div>
          ))}
        </div>

        {days.map((day, di) => (
          <div key={di} className={[
            'hm-row',
            day.today   ? 'hm-today'   : '',
            day.weekend ? 'hm-weekend' : '',
          ].filter(Boolean).join(' ')}>
            <div className="hm-label">{day.label}</div>
            {day.hours.map(cell => {
              const pct = cell.splitFrac !== undefined ? Math.round(cell.splitFrac * 100) : undefined
              const splitStyle = pct !== undefined && !cell.past ? {
                background: cell.splitToPeak
                  ? `linear-gradient(to right, #00cc35 ${pct}%, #ff7a00 ${pct}%)`
                  : `linear-gradient(to right, #ff7a00 ${pct}%, #00cc35 ${pct}%)`,
              } : undefined
              const hh = String(cell.hour).padStart(2, '0')
              const title = pct !== undefined
                ? `${hh}:00 local — split: ${cell.splitToPeak ? 'off-peak → PEAK' : 'PEAK → off-peak'} at :${String(Math.round((cell.splitFrac ?? 0) * 60)).padStart(2, '0')}`
                : `${hh}:00 local — ${cell.peak ? 'PEAK (2×)' : 'OFF-PEAK (1×)'}`
              return (
                <div
                  key={cell.hour}
                  className={[
                    'hm-cell',
                    cell.peak ? 'hm-peak' : 'hm-off',
                    cell.past ? 'hm-past' : 'hm-future',
                    cell.current ? 'hm-current' : '',
                    pct !== undefined ? 'hm-split' : '',
                  ].filter(Boolean).join(' ')}
                  style={splitStyle}
                  title={title}
                />
              )
            })}
          </div>
        ))}
      </div>
    </section>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [booted, setBooted] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const [previewFlip, setPreviewFlip] = useState(false)

  // Clock tick — every second
  useEffect(() => {
    if (!booted) return
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [booted])

  const peakNow    = isPeak(now)
  const displayPeak = previewFlip ? !peakNow : peakNow

  // Recompute transitions every minute (or when peak status flips)
  const minuteTick = Math.floor(now.getTime() / 60_000)
  const next = useMemo(() => findTransition(now, true),  [minuteTick])
  const last = useMemo(() => findTransition(now, false), [minuteTick])
  const days = useMemo(() => build7Days(now),            [minuteTick])

  if (!booted) return <BootScreen onDone={() => setBooted(true)} />

  const tz      = localTZ()
  const tzShort = tz.split('/').pop()?.replace(/_/g, ' ') ?? tz
  const localTime = fmtTime(now, tz)
  const etTime    = fmtTime(now, ET_TZ)
  const etLabel   = fmtETOffset()
  const utcTime   = fmtTime(now, 'UTC')

  const [nh, nm, ns] = msToHMS(next.getTime() - now.getTime())
  const [lh, lm, ls] = msToHMS(now.getTime() - last.getTime())
  const lastTimeStr   = fmtTime(last, tz)

  // Period progress bar
  const periodLen = next.getTime() - last.getTime()
  const progress  = Math.min(100, Math.round(((now.getTime() - last.getTime()) / periodLen) * 100))

  // Weekend / time-of-day context (always based on real time)
  const utcDow     = now.getUTCDay()
  const isWeekend  = utcDow === 0 || utcDow === 6
  const utcH       = now.getUTCHours()
  const isPrePeak  = !isWeekend && utcH < PEAK_START_UTC
  const isPostPeak = !isWeekend && utcH >= PEAK_END_UTC

  const statusText = displayPeak
    ? 'PEAK ACTIVE'
    : isWeekend
      ? 'OFF-PEAK — WEEKEND'
      : isPrePeak
        ? 'OFF-PEAK — PRE-PEAK'
        : 'OFF-PEAK — POST-PEAK'

  const nextLabel = displayPeak
    ? 'RETURNING TO OFF-PEAK IN'
    : isWeekend || isPostPeak
      ? 'PEAK RESUMES IN'
      : 'ENTERING PEAK HOURS IN'

  const sinceLabel = displayPeak
    ? 'PEAK MODE'
    : isWeekend
      ? 'WEEKEND OFF-PEAK'
      : 'OFF-PEAK MODE'

  const rateText = displayPeak ? '2.0×  DOUBLE DRAIN' : '1.0×  NORMAL RATE'

  return (
    <div className={`app ${displayPeak ? 'mode-peak' : 'mode-off'}`}>
      <div className="scanlines" />
      <div className="vignette" />

      {/* ── Header ── */}
      <header className="term-header">
        <div className="hdr-left">
          <span className="hdr-title">
            CLAUDE_PEAK_MONITOR <span className="dim">v2.0</span>
          </span>
          {import.meta.env.DEV && (
            <button
              className={`preview-btn ${previewFlip ? 'preview-active' : ''}`}
              onClick={() => setPreviewFlip(f => !f)}
            >
              {previewFlip ? '◉ LIVE' : '◎ PREVIEW'}
            </button>
          )}
        </div>
        <div className="hdr-clocks">
          <span className="clk-block">
            <span className="clk-lbl">LOCAL</span>
            <span className="clk-val">{localTime}</span>
            <span className="clk-tz">{tzShort}</span>
          </span>
          <span className="clk-divider">│</span>
          <span className="clk-block">
            <span className="clk-lbl">ET</span>
            <span className="clk-val">{etTime}</span>
            <span className="clk-tz">{etLabel}</span>
          </span>
          <span className="clk-divider">│</span>
          <span className="clk-block">
            <span className="clk-lbl">UTC</span>
            <span className="clk-val">{utcTime}</span>
          </span>
        </div>
      </header>

      <div className="content">

        {/* ── Status + Rate row ── */}
        <div className="top-row">
          <div className={`status-badge ${displayPeak ? 's-peak' : 's-off'}`}>
            <span className="pulse-dot" />
            <span className="status-text">{statusText}</span>
          </div>

          <div className="rate-panel">
            <span className="rate-lbl">USAGE RATE</span>
            <div className="rate-track">
              <div
                className={`rate-fill ${displayPeak ? 'rf-peak' : 'rf-off'}`}
                style={{ width: displayPeak ? '100%' : '50%' }}
              />
              <div className="rate-mid-marker" />
            </div>
            <span className={`rate-val ${displayPeak ? 'rv-peak' : 'rv-off'}`}>{rateText}</span>
          </div>

          <div className="period-progress">
            <span className="pp-lbl">PERIOD PROGRESS</span>
            <div className="pp-track">
              <div className="pp-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="pp-pct dim">{progress}%</span>
          </div>
        </div>

        {/* ── Countdown ── */}
        <section className="countdown-section">
          <div className="cd-label">{nextLabel}</div>
          <div className="cd-digits">
            <div className="cd-group">
              <span className="cd-num">{nh}</span>
              <span className="cd-unit">HH</span>
            </div>
            <span className="cd-colon">:</span>
            <div className="cd-group">
              <span className="cd-num">{nm}</span>
              <span className="cd-unit">MM</span>
            </div>
            <span className="cd-colon">:</span>
            <div className="cd-group">
              <span className="cd-num">{ns}</span>
              <span className="cd-unit">SS</span>
            </div>
          </div>
          <div className="cd-since">
            [{sinceLabel}] active since {lastTimeStr} {tzShort}
            <span className="dim"> · {lh}h {lm}m {ls}s ago</span>
          </div>
        </section>

        {/* ── 7-day heatmap ── */}
        <HeatmapGrid days={days} />

      </div>
    </div>
  )
}
