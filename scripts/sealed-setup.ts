// Puts the deposit down for the sealed sellers: the buyer sends each one its gas and deposit,
// and the seller deposits. Run: npx bun run scripts/sealed-setup.ts [--dry-run]
// The amounts are constants on purpose, not arguments.
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { loadKeys, loadSealedSellerKeys } from '../server/keys'
import { ANSWER_GAS, APPROVE_GAS, ARC_NET, createSealedDelivery, DEPOSIT_GAS, parseSealedAddress } from '../server/sealedDelivery'
import type { SealedClient } from '../server/sealedDelivery'
import { formatUsdc, parseUsdc } from '../src/onchain-money'

export const SELLER_DEPOSIT = parseUsdc('0.1')
export const SELLER_GAS = parseUsdc('0.03')

export interface SetupPlan {
  name: string
  address: Address
  sendToSeller: bigint
  deposit: bigint
}

/** Reads only. Says what each seller is still missing. */
export async function planSetup(client: SealedClient, sellers: { name: string; key: Hex }[]): Promise<SetupPlan[]> {
  const plans: SetupPlan[] = []
  for (const { name, key } of sellers) {
    const address = privateKeyToAccount(key).address
    const [deposited, balance] = await Promise.all([client.deposits(address), client.usdcBalance(address)])
    const deposit = deposited >= SELLER_DEPOSIT ? 0n : SELLER_DEPOSIT - deposited
    const wanted = SELLER_GAS + deposit
    plans.push({ name, address, deposit, sendToSeller: balance >= wanted ? 0n : wanted - balance })
  }
  return plans
}

/**
 * Stops before anything is sent when the gas budget cannot put the deposit down and answer once at
 * today's price. Also says how many answers the rest of the budget would pay for.
 */
export async function checkGasBudget(client: SealedClient): Promise<{ cost: bigint; budget: bigint; enough: boolean; answers: bigint }> {
  const cost = await client.exactGasCost(APPROVE_GAS + DEPOSIT_GAS + ANSWER_GAS)
  const oneAnswer = await client.exactGasCost(ANSWER_GAS)
  const answers = cost <= SELLER_GAS ? 1n + (SELLER_GAS - cost) / oneAnswer : 0n
  return { cost, budget: SELLER_GAS, enough: cost <= SELLER_GAS, answers }
}

export async function runSetup(client: SealedClient, buyerKey: Hex, sellers: { name: string; key: Hex }[], log: (line: string) => void) {
  const { cost, budget, enough } = await checkGasBudget(client)
  if (!enough) {
    throw new Error(`The gas budget is ${formatUsdc(budget)} USDC and today's price needs ${formatUsdc(cost)} USDC. Nothing was sent.`)
  }
  const plans = await planSetup(client, sellers)
  const total = plans.reduce((sum, plan) => sum + plan.sendToSeller, 0n)
  const buyerHas = await client.usdcBalance(privateKeyToAccount(buyerKey).address)
  if (buyerHas < total) throw new Error(`The buyer has ${formatUsdc(buyerHas)} USDC and this needs ${formatUsdc(total)} USDC. Nothing was sent.`)

  for (const plan of plans) {
    const seller = sellers.find((s) => s.name === plan.name)!
    if (plan.sendToSeller > 0n) await client.transferUsdc(buyerKey, plan.address, plan.sendToSeller)
    if (plan.deposit > 0n) await client.deposit(seller.key, plan.deposit)
    log(`${plan.name}: sent ${formatUsdc(plan.sendToSeller)} USDC, deposited ${formatUsdc(plan.deposit)} USDC.`)
  }
}

if (import.meta.main) {
  const address = parseSealedAddress(process.env.SEALED_DELIVERY_ADDRESS)
  if (!address) throw new Error('SEALED_DELIVERY_ADDRESS is missing or is not an address.')
  const client = createSealedDelivery({ address, net: ARC_NET })
  const keys = loadKeys()
  const extra = loadSealedSellerKeys()
  const sellers = [
    { name: 'Seller A', key: keys.sellerA },
    { name: 'Seller D', key: extra.sellerD },
    { name: 'Seller E', key: extra.sellerE },
    { name: 'Seller F', key: extra.sellerF },
  ]
  const plans = await planSetup(client, sellers)
  const { cost, budget, enough, answers } = await checkGasBudget(client)
  for (const plan of plans) {
    console.log(`${plan.name} ${plan.address}: send ${formatUsdc(plan.sendToSeller)} USDC, deposit ${formatUsdc(plan.deposit)} USDC.`)
  }
  console.log(`Gas for a seller at today's price: ${formatUsdc(cost)} USDC of the ${formatUsdc(budget)} USDC budget (${enough ? `enough, about ${answers} answers` : 'NOT enough'}).`)
  if (process.argv.includes('--dry-run')) process.exit(enough ? 0 : 1)
  await runSetup(client, keys.buyer, sellers, console.log)
}
