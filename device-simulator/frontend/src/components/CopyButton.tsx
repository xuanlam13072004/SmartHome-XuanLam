import { useEffect, useState } from 'react'
import { Icon } from './Icon'

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
  }

  return (
    <button className="button button--quiet button--compact" data-state={copied ? 'success' : 'default'} onClick={() => void copy()} type="button">
      <Icon name="copy" size={15} />
      {copied ? 'Copied' : label}
    </button>
  )
}
