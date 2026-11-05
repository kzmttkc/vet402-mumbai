/**
 * `?film` lays the screen out for the demo recording: only the newest receipt shows beside the
 * controls, and the Studio badge moves to the top corner where it covers nothing.
 */
export const FILM_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('film')
