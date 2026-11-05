// qrcode 1.5.4 ships no types. Only the call this app makes is declared.
declare module 'qrcode' {
  interface ToStringOptions {
    type: 'svg'
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    margin?: number
  }
  const qrcode: { toString(text: string, options: ToStringOptions): Promise<string> }
  export default qrcode
}
