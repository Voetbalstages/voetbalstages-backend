import { env } from '../env.js'
import { badGateway } from '../lib/errors.js'

export interface PlacesGateway {
  autocomplete(input: string): Promise<{ placeId: string; description: string }[]>
  geocode(placeId: string): Promise<Record<string, unknown> | null>
}

const call = async (path: string, params: Record<string, string>) => {
  if (!env.GOOGLE_PLACES_API_KEY) throw badGateway('PLACES_NOT_CONFIGURED', 'GOOGLE_PLACES_API_KEY is not set')
  const url = new URL(`https://maps.googleapis.com/maps/api/${path}/json`)
  for (const [k, v] of Object.entries({ ...params, key: env.GOOGLE_PLACES_API_KEY })) url.searchParams.set(k, v)
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null)
  if (!res?.ok) throw badGateway('PLACES_ERROR', 'Google Places request failed')
  const data = (await res.json()) as any
  if (data.status && !['OK', 'ZERO_RESULTS'].includes(data.status)) throw badGateway('PLACES_ERROR', `Google: ${data.status}`)
  return data
}

const googleGateway: PlacesGateway = {
  async autocomplete(input) {
    const data = await call('place/queryautocomplete', { input })
    return (data.predictions ?? [])
      .filter((p: any) => p.place_id)
      .map((p: any) => ({ placeId: p.place_id as string, description: p.description as string }))
  },
  /** Same field mapping as the old googleMapsApi.geocode. */
  async geocode(placeId) {
    const data = await call('geocode', { place_id: placeId })
    const r = data.results?.[0]
    if (!r) return null
    const get = (type: string) => r.address_components.find((c: any) => c.types.includes(type))?.long_name
    const locality = get('locality')
    const sub = get('sublocality_level_1')
    return {
      formatted: r.formatted_address,
      streetAddress: [get('route'), get('street_number')].filter(Boolean).join(' '),
      postcode: get('postal_code') ?? '',
      district: sub && sub !== locality ? sub : '',
      city: locality ?? '',
      province: get('administrative_area_level_2') ?? '',
      placeId,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng
    }
  }
}

let gateway = googleGateway
export const places = () => gateway
export const setPlacesGateway = (g: PlacesGateway) => (gateway = g)
