// vet402 pre-event Gateway rail, copied at tag mumbai-pre-event-2026 (public repo kzmttkc/vet402).

// Source: src/lib/observatory/arc-gateway.ts and x402-payer.ts. DB and catalog code left out.

import { isAddress } from "viem";



export const ARC_CAIP2 = "eip155:5042002";

export const ARC_USDC = "0x3600000000000000000000000000000000000000";

export const ARC_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

export const ARC_GATEWAY_DOMAIN_NAME = "GatewayWalletBatched";

export const ARC_GATEWAY_DOMAIN_VERSION = "1";

export const ARC_GATEWAY_API = "https://gateway-api-testnet.circle.com/v1";

export const ARC_GATEWAY_MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60 + 100;



export type ChallengeAccept = {
  scheme: string;
  network: string;
  /** Base units as decimal string (v1 maxAmountRequired normalized here). */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

export type Eip3009Authorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The seller's verifyingContract string when it is the pinned wallet (case ignored), else null.
 * The facilitator compares `accepted` with the seller's requirements as exact strings, so the
 * header must carry the seller's spelling. The signing domain stays ARC_GATEWAY_WALLET.
 */
export function gatewayEchoedVerifyingContract(extra: unknown): string | null {
  const rec = asRecord(extra);
  if (!rec || typeof rec.verifyingContract !== "string") return null;
  return rec.verifyingContract.toLowerCase() === ARC_GATEWAY_WALLET.toLowerCase() ? rec.verifyingContract : null;
}

/**
 * A live or catalog accept this rail may sign. name and version are the pin.
 * verifyingContract is the seller's string, kept only after it matched the pin (case ignored),
 * so the PAYMENT-SIGNATURE `accepted` echoes what the seller sent.
 */
export function arcGatewayAcceptOf(raw: unknown): ChallengeAccept | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (rec.scheme !== "exact") return null;
  if (rec.network !== ARC_CAIP2) return null;
  if (typeof rec.amount !== "string" || !/^[0-9]+$/.test(rec.amount)) return null;
  if (typeof rec.asset !== "string" || rec.asset.toLowerCase() !== ARC_USDC.toLowerCase()) return null;
  if (typeof rec.payTo !== "string" || !isAddress(rec.payTo)) return null;
  const extra = asRecord(rec.extra);
  if (!extra) return null;
  if (extra.name !== ARC_GATEWAY_DOMAIN_NAME) return null;
  if (extra.version !== ARC_GATEWAY_DOMAIN_VERSION) return null;
  if (typeof extra.verifyingContract !== "string") return null;
  if (extra.verifyingContract.toLowerCase() !== ARC_GATEWAY_WALLET.toLowerCase()) return null;
  if (extra.salt !== undefined) return null;
  if (extra.chainId !== undefined && extra.chainId !== 5042002 && extra.chainId !== "5042002") return null;
  if (rec.maxTimeoutSeconds !== undefined && !Number.isInteger(rec.maxTimeoutSeconds)) return null;
  if (typeof rec.maxTimeoutSeconds === "number" && rec.maxTimeoutSeconds > ARC_GATEWAY_MAX_TIMEOUT_SECONDS) return null;
  const echoedContract = gatewayEchoedVerifyingContract(extra);
  if (echoedContract === null) return null;
  return {
    scheme: "exact",
    network: ARC_CAIP2,
    amount: rec.amount,
    asset: ARC_USDC,
    payTo: rec.payTo,
    ...(typeof rec.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: rec.maxTimeoutSeconds } : {}),
    extra: {
      name: ARC_GATEWAY_DOMAIN_NAME,
      version: ARC_GATEWAY_DOMAIN_VERSION,
      verifyingContract: echoedContract,
    },
  };
}

/**
 * The same accept as arcGatewayAcceptOf, with the seller's own `extra` put back.
 * arcGatewayAcceptOf keeps only name, version and verifyingContract, but some sellers
 * require more fields in `accepted.extra` and the facilitator compares it with their
 * requirements. Every check in arcGatewayAcceptOf runs first. Only when they all pass is
 * the seller's `extra` copied back, unchanged, so a rejected accept never reaches a header.
 * Signing never uses this extra: the signing domain stays the pinned wallet.
 */
export function arcGatewayAcceptWithSellerExtra(raw: unknown): ChallengeAccept | null {
  const checked = arcGatewayAcceptOf(raw);
  if (checked === null) return null;
  const sellerExtra = asRecord(asRecord(raw)?.extra);
  if (sellerExtra === null) return null;
  return { ...checked, extra: structuredClone(sellerExtra) };
}

/**
 * Wrap the signed payload in the transport the CHALLENGE spoke.
 *  v2 → PAYMENT-SIGNATURE: { x402Version:2, resource, accepted, payload }
 *  v1 → X-PAYMENT:        { x402Version:1, scheme, network(slug), payload }
 */
export function encodePaymentHeader(input: {
  x402Version: 1 | 2;
  accept: ChallengeAccept;
    payload:
    | { signature: string; authorization: Eip3009Authorization }
    | { signedTxBlob: string; invoiceId: string }
    | { transaction: string };
  resourceUrl: string;
  /**
   * v2 only. The seller's 402 `resource`, copied as is. Only the Arc Gateway rail passes it
   * (arc-gateway.ts gatewaySellerResource). Left out, the header keeps `{ url: resourceUrl }`.
   */
  resource?: Record<string, unknown>;
}): { headerName: string; headerValue: string } {
  const { x402Version, accept, payload, resourceUrl } = input;
  const body = {
    x402Version: 2,
    resource: input.resource ?? { url: resourceUrl },
    accepted: {
      scheme: accept.scheme,
      network: accept.network,
      amount: accept.amount,
      asset: accept.asset,
      payTo: accept.payTo,
      ...(accept.maxTimeoutSeconds !== undefined
        ? { maxTimeoutSeconds: accept.maxTimeoutSeconds }
        : {}),
      ...(accept.extra !== undefined ? { extra: accept.extra } : {}),
    },
    payload,
  };
  return {
    headerName: "PAYMENT-SIGNATURE",
    headerValue: Buffer.from(JSON.stringify(body)).toString("base64"),
  };
}
