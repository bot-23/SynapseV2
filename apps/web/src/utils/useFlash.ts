import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 一闪而过的提示条：显示一段时间后自动消失。
 *
 * 定时器存在 ref 里、卸载时清掉，并保证同一时刻只有一个在跑：
 * 否则连续提示会堆出一串没人回收的计时器，切页后还会对着已卸载的组件 setState。
 */
export function useFlash(durationMs = 2600): [string, (message: string) => void] {
  const [notice, setNotice] = useState('')
  const timer = useRef<number | null>(null)

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const flash = useCallback(
    (message: string) => {
      clear()
      setNotice(message)
      timer.current = window.setTimeout(() => {
        timer.current = null
        setNotice('')
      }, durationMs)
    },
    [clear, durationMs],
  )

  useEffect(() => clear, [clear])

  return [notice, flash]
}
