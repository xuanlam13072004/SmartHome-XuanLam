import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MainView, NavigationItem } from '../App'
import { Icon } from './Icon'

export function CommandPalette({
  infrastructureReady,
  items,
  onNavigate,
}: {
  infrastructureReady: boolean
  items: NavigationItem[]
  onNavigate: (view: MainView) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return items
    return items.filter((item) =>
      `${item.label} ${item.description}`.toLowerCase().includes(normalized),
    )
  }, [items, query])

  const open = () => {
    setQuery('')
    setActiveIndex(0)
    dialogRef.current?.showModal()
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const close = () => dialogRef.current?.close()

  const choose = (item: NavigationItem) => {
    onNavigate(item.id)
    close()
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (dialogRef.current?.open) close()
        else open()
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  })

  useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(Math.max(0, results.length - 1))
  }, [activeIndex, results.length])

  return (
    <>
      <button className="command-trigger" onClick={open} type="button">
        <Icon name="search" />
        <span>Tìm hoặc chuyển nhanh</span>
        <kbd>Ctrl K</kbd>
      </button>

      <dialog
        aria-labelledby={`${listId}-title`}
        className="command-dialog"
        onClick={(event) => {
          if (event.target === dialogRef.current) close()
        }}
        ref={dialogRef}
      >
        <div className="command-frame">
          <header>
            <Icon name="search" />
            <input
              aria-controls={listId}
              aria-label="Tìm màn hình trong simulator"
              onChange={(event) => {
                setQuery(event.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setActiveIndex((current) => Math.min(current + 1, results.length - 1))
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setActiveIndex((current) => Math.max(current - 1, 0))
                }
                if (event.key === 'Enter' && results[activeIndex]) {
                  event.preventDefault()
                  choose(results[activeIndex])
                }
              }}
              placeholder="Tìm thiết bị, người dùng, phiên hoặc hệ thống"
              ref={inputRef}
              value={query}
            />
            <button aria-label="Đóng bảng điều hướng" onClick={close} type="button">Esc</button>
          </header>
          <div className="command-context">
            <span className={`status-mark status-mark--${infrastructureReady ? 'ok' : 'warning'}`} />
            {infrastructureReady ? 'Hạ tầng sẵn sàng' : 'Cần kiểm tra hệ thống'}
          </div>
          <p className="visually-hidden" id={`${listId}-title`}>Điều hướng Simulator</p>
          <ul id={listId} role="listbox">
            {results.map((item, index) => (
              <li key={item.id}>
                <button
                  aria-selected={index === activeIndex}
                  onClick={() => choose(item)}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  type="button"
                >
                  <Icon name={item.icon} />
                  <span><strong>{item.label}</strong><small>{item.description}</small></span>
                  <kbd>↵</kbd>
                </button>
              </li>
            ))}
          </ul>
          {results.length === 0 && (
            <p className="command-empty">Không có màn hình phù hợp với “{query}”.</p>
          )}
        </div>
      </dialog>
    </>
  )
}
