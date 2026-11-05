/** How the screen offers an IDKit request. The request URL itself is never shown as text. */
export type RequestPresentation = { kind: 'copy' } | { kind: 'qr'; image: string }

/**
 * Staging is pasted into the World ID Simulator, so the screen offers a copy button.
 * Production is scanned with World App on a phone, so the screen shows a QR code image.
 */
export async function presentRequest(environment: string, connectorURI: string): Promise<RequestPresentation> {
  if (environment !== 'production') return { kind: 'copy' }
  // Loaded only for production, so the staging screen never pulls the QR code in.
  const qr = (await import('qrcode')).default
  const svg = await qr.toString(connectorURI, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 })
  return { kind: 'qr', image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }
}
