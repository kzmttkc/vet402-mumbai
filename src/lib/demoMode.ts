import { FILM_MODE } from '@/lib/filmMode'

/**
 * The scene buttons (the lost-answer demo, Sellers A to F, Seller C, the comparison retry) are for
 * recording only. They show with `?demo`, or `?film` for the recording layout, and never by default.
 */
export const DEMO_CONTROLS = FILM_MODE || (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo'))
