import { erc20Abi } from 'viem'
import type { Address } from 'viem'
import type { GatewayClient } from '@circle-fin/x402-batching/client'
import { getUsdc } from '../src/onchain-facts'
import { Amount, formatUsdc, gasTokenToUsdc, gasTokenDecimalsFor } from '../src/onchain-money'
import type { HoldPorts } from './hold'

// Upper bound on the gas a Gateway withdrawal (the mint) can use.
const WITHDRAW_MINT_GAS = 500_000n
// Gas prices move, so keep a cushion on every estimate.
const FEE_CUSHION = 2n

export function createHoldPorts(chainId: number, buyer: GatewayClient, hold: GatewayClient): HoldPorts {
  const usdcFact = getUsdc(chainId)
  if (!usdcFact) throw new Error(`No USDC registered for chain ${chainId}`)
  const usdc = usdcFact.address as Address

  // Gas is paid from the same USDC pool, so convert the cost into USDC units, rounding up.
  async function gasCostInUsdc(gas: bigint): Promise<bigint> {
    const gasPrice = await hold.publicClient.getGasPrice()
    const cost = Amount.fromRaw(gas * gasPrice * FEE_CUSHION, gasTokenDecimalsFor(chainId))
    return gasTokenToUsdc(chainId, cost).raw + 1n
  }

  async function transfer(from: GatewayClient, to: Address, amount: bigint): Promise<void> {
    const hash = await from.walletClient.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, amount],
    })
    await from.publicClient.waitForTransactionReceipt({ hash })
  }

  return {
    async buyerWallet() {
      return (await buyer.getBalances()).wallet.balance
    },

    async hold() {
      const balances = await hold.getBalances()
      return { wallet: balances.wallet.balance, available: balances.gateway.available }
    },

    gasReserve() {
      return gasCostInUsdc(WITHDRAW_MINT_GAS)
    },

    fundHoldWallet(amount) {
      return transfer(buyer, hold.address, amount)
    },

    async withdrawToBuyer(amount) {
      await hold.withdraw(formatUsdc(amount), { recipient: buyer.address })
    },

    async sweepToBuyer() {
      const { balance } = (await hold.getBalances()).wallet
      const gas = await hold.publicClient.estimateContractGas({
        address: usdc,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [buyer.address, balance],
        account: hold.account,
      })
      const cost = await gasCostInUsdc(gas)
      // Anything that would not cover its own transfer stays behind.
      if (balance <= cost) return
      await transfer(hold, buyer.address, balance - cost)
    },

    async depositForHold(amount) {
      await buyer.depositFor(formatUsdc(amount), hold.address)
    },
  }
}
