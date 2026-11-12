import type { ReactNode } from 'react'
import { motion, type HTMLMotionProps } from 'framer-motion'
import { useSettings } from '@/trading/settings'

/**
 * Entrance animations that obey Settings > Motion and the system "reduce motion" request.
 * With motion off the children render as they are, with no wrapper animation at all.
 */
export function Reveal({ children, delay = 0, y = 22, className, as = 'div' }: { children: ReactNode; delay?: number; y?: number; className?: string; as?: 'div' | 'section' | 'li' }) {
  const { animate, motion: level } = useSettings()
  if (!animate) {
    const Tag = as
    return <Tag className={className}>{children}</Tag>
  }
  const M = motion[as] as React.ComponentType<HTMLMotionProps<'div'>>
  return (
    <M
      className={className}
      initial={{ opacity: 0, y: level === 'reduced' ? 0 : y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: level === 'reduced' ? 0.2 : 0.6, delay: level === 'reduced' ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </M>
  )
}

/** Fades and lifts a page in when it mounts. Pair with AnimatePresence in the shell. */
export function PageFade({ children, pageKey }: { children: ReactNode; pageKey: string }) {
  const { animate, motion: level } = useSettings()
  if (!animate) return <div key={pageKey}>{children}</div>
  return (
    <motion.div
      key={pageKey}
      initial={{ opacity: 0, y: level === 'reduced' ? 0 : 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: level === 'reduced' ? 0 : -8 }}
      transition={{ duration: level === 'reduced' ? 0.12 : 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}
