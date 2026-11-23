import { createContext, useContext } from 'react'
import { ApiError } from '../api'
import { readError } from '../components/format'
import type { Staff } from '../types'

/** The signed-in staff member and what they may do (the Console backend and the Gateway check again). */
export interface ConsoleAccess {
  staff: Staff
  /** The Console is connected to a Simulator. */
  simulator: boolean
  can: (permission: string) => boolean
}

export const ConsoleContext = createContext<ConsoleAccess | null>(null)

export const accessFor = (staff: Staff, simulator: boolean): ConsoleAccess => ({
  staff,
  simulator,
  can: (permission) => staff.is_root || (permission !== 'staff.manage' && staff.permissions.includes(permission)),
})

/** A refusal the Gateway explained (wrong password, e-mail taken) reads best as is; anything else gets [fallback]. */
export const explain = (caught: unknown, fallback: string): string =>
  caught instanceof ApiError && caught.status < 500 ? caught.message : readError(caught, fallback)

export function useConsole(): ConsoleAccess {
  const access = useContext(ConsoleContext)
  if (!access) throw new Error('useConsole outside the signed-in Console')
  return access
}
