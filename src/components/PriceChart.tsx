import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { clsx } from 'clsx'
import { TIMEFRAMES, sma, type Candle, type Timeframe } from '@/trading/market'
import { useSettings } from '@/trading/settings'
import { Notice, Skeleton } from './ui'

function cssRgb(name: string, alpha = 1): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim().replace(/\s+/g, ' ')
  return `rgb(${v} / ${alpha})`
}

interface Props {
  candles: Candle[]
  loading: boolean
  error: string | null
  timeframe: Timeframe
  onTimeframe: (t: Timeframe) => void
  source: string | null
  live: boolean
}

export function PriceChart({ candles, loading, error, timeframe, onTimeframe, source, live }: Props) {
  const { theme } = useSettings()
  const host = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const smaRef = useRef<ISeriesApi<'Line'> | null>(null)
  const [showVol, setShowVol] = useState(true)
  const [showSma, setShowSma] = useState(true)
  const fitted = useRef('')

  useEffect(() => {
    if (!host.current) return
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssRgb('muted'), fontFamily: 'DM Sans' },
      grid: { vertLines: { color: cssRgb('line', 0.5) }, horzLines: { color: cssRgb('line', 0.5) } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: cssRgb('line') },
      timeScale: { borderColor: cssRgb('line'), timeVisible: true, secondsVisible: false },
    })
    chartRef.current = chart
    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: cssRgb('up'),
      downColor: cssRgb('down'),
      wickUpColor: cssRgb('up'),
      wickDownColor: cssRgb('down'),
      borderVisible: false,
    })
    volRef.current = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol' })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    smaRef.current = chart.addSeries(LineSeries, { color: cssRgb('accent'), lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: { textColor: cssRgb('muted') },
      grid: { vertLines: { color: cssRgb('line', 0.5) }, horzLines: { color: cssRgb('line', 0.5) } },
      rightPriceScale: { borderColor: cssRgb('line') },
      timeScale: { borderColor: cssRgb('line') },
    })
    candleRef.current?.applyOptions({ upColor: cssRgb('up'), downColor: cssRgb('down'), wickUpColor: cssRgb('up'), wickDownColor: cssRgb('down') })
    smaRef.current?.applyOptions({ color: cssRgb('accent') })
  }, [theme])

  const sma20 = useMemo(() => sma(candles, 20), [candles])

  useEffect(() => {
    const t = (n: number) => n as UTCTimestamp
    candleRef.current?.setData(candles.map((c) => ({ time: t(c.time), open: c.open, high: c.high, low: c.low, close: c.close })))
    volRef.current?.setData(
      showVol ? candles.map((c) => ({ time: t(c.time), value: c.volume, color: c.close >= c.open ? cssRgb('up', 0.35) : cssRgb('down', 0.35) })) : [],
    )
    smaRef.current?.setData(showSma ? sma20.map((p) => ({ time: t(p.time), value: p.value })) : [])
    const key = `${timeframe}:${candles[0]?.time ?? 0}`
    if (candles.length && fitted.current !== key) {
      chartRef.current?.timeScale().fitContent()
      fitted.current = key
    }
  }, [candles, showVol, showSma, sma20, timeframe])

  const toggles: [string, boolean, (v: boolean) => void][] = [
    ['Vol', showVol, setShowVol],
    ['MA 20', showSma, setShowSma],
  ]

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="flex gap-0.5" role="tablist" aria-label="Timeframe">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === timeframe}
              onClick={() => onTimeframe(t.id)}
              className={clsx('num min-h-[30px] rounded-md px-2.5 text-xs transition', t.id === timeframe ? 'bg-raised text-ink' : 'text-mute hover:text-ink')}
            >
              {t.id}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-xs">
          {toggles.map(([label, on, set]) => (
            <button
              key={label}
              onClick={() => set(!on)}
              aria-pressed={on}
              className={clsx('min-h-[30px] rounded-md border px-2 transition', on ? 'border-accent/60 text-accent' : 'border-line text-mute hover:text-ink')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative h-[280px] sm:h-[380px]">
        <div ref={host} className="absolute inset-0" />
        {loading && candles.length === 0 && <Skeleton className="absolute inset-3" />}
        {error && (
          <div className="absolute inset-x-3 top-3">
            <Notice tone="error" title="Market data unavailable">
              {error}.
            </Notice>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[11px] text-mute">
        <span>{source ? `Reference chart: Coinbase ${source}. Not an Arc pool price.` : 'No reference market for this asset.'}</span>
        <span className={clsx('flex items-center gap-1', live && 'text-up')}>
          <span className={clsx('h-1.5 w-1.5 rounded-full', live ? 'bg-up' : 'bg-mute/50')} />
          {live ? 'Live' : 'Not streaming'}
        </span>
      </div>
    </div>
  )
}
