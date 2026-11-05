import type { Hex } from 'viem'
import { encodeBox } from '../src/lib/swarmBox'
import type { SwarmWire } from '../src/lib/swarmBox'
import type { SealedBox } from './sealedDelivery'

/**
 * What the buyer keeps on Swarm when it claims: the box it already holds, with the claim, the
 * contract and the chain. No key goes in. Returns the unencrypted reference.
 */
export function createEvidenceUploader({ swarm, contract, chainId }: { swarm: SwarmWire; contract: string; chainId: number }) {
  return (box: SealedBox, claimId: Hex): Promise<string> =>
    swarm.upload(
      encodeBox({
        ciphertext: box.ciphertext,
        claimId,
        plaintextHash: box.promise.plaintextHash,
        ciphertextHash: box.promise.ciphertextHash,
        contract,
        chainId,
      }),
    )
}
