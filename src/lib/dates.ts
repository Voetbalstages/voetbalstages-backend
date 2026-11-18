export const formatDate = (d: Date | string | null | undefined) => {
  if (!d) return ''
  const date = new Date(d)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`
}

export const yearRange = (year: number) => ({
  $gte: new Date(Date.UTC(year, 0, 1)),
  $lt: new Date(Date.UTC(year + 1, 0, 1))
})

export const currency = (n: number) =>
  new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR' }).format(n)
