// compass-deploy.ts comes from the Arc Studio starter, which supplies this package at deploy time.
// It is not a dependency of this app, so this declaration keeps the type check honest for everything else.
declare module '@circlefin/compass-chains' {
  export function getChain(id: string): {
    name: string
    explorerUrl?: string
    nativeCurrency: { symbol: string }
  }
}
