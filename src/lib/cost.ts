import type { Settings } from '../db/models/index.js'

const DAY = 24 * 60 * 60 * 1000

/** Ported from voetbalstages/lib checkBeforeDate: is `now` more than `days` before `from`? */
export const isBefore = (from: Date | string | number, days: number, now = Date.now()) =>
  now < new Date(from).getTime() - days * DAY

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export interface CostDetail {
  cost: number
  currentDiscount: number
  currentDiscountToInc: Date | null
  deposit: number
  depositTotal: number
  forcePay: boolean
  subTotal: number
  total: number
}

type CampForCost = {
  from?: Date | null
  earlyBirdToInc?: Date | null
  cost?: number | null
  deposit?: number | null
}

/** Ported 1:1 from voetbalstages/lib calculateCampCost. */
export const calculateCampCost = (
  camp: CampForCost,
  settings: Settings,
  now = Date.now()
): CostDetail => {
  const earlyBirdToInc = camp.earlyBirdToInc ?? settings.earlyBirdToInc ?? null
  const cost = Number(camp.cost ?? 0)
  const currentDiscount =
    earlyBirdToInc && now < new Date(earlyBirdToInc).getTime()
      ? Number(settings.earlyBirdDiscount ?? 0)
      : 0
  const from = camp.from ?? now
  const deposit = isBefore(from, settings.depositDays ?? 14, now) ? Number(camp.deposit ?? 0) : 0
  return {
    cost,
    currentDiscount,
    currentDiscountToInc: earlyBirdToInc,
    deposit,
    depositTotal: deposit || 0,
    forcePay: !isBefore(from, settings.forcePayDays ?? 14, now),
    subTotal: cost - currentDiscount,
    total: cost - currentDiscount
  }
}
