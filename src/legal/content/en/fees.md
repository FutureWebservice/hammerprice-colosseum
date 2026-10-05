---
title: "Fees"
description: "What Hammerprice costs: a brokerage fee for sellers, nothing for buyers, and who pays network fees."
---

# Fees

Version {{VERSION}}, last updated {{LAST_UPDATED}}

## In short

| Who | What | How much |
|---|---|---|
| Buyer | Fee to Hammerprice | none |
| Seller | Brokerage fee to Hammerprice | {{PLATFORM_FEE_PERCENT}} of the hammer price, only on a sale |
| Pack operator | Brokerage fee to Hammerprice | {{PLATFORM_FEE_PERCENT}} of the pack price, deducted in the same transaction; the buyer pays no fee to us |
| Seller, optional | AI credits for AI drafts | 1 USDC buys 10 credits, one credit per draft. Credits are switched off during the judging period (AI is free then). The AI agent never uses a credit |
| Both | Blockchain network fees | small, not paid to us; see "Network fees" below |
| Depending on the lot | Creator royalty, fees of the vault operator | set by third parties, see "Third-party fees" below |

Bidding, watching, listing a lot, your profile, Telegram notifications and the waiting list are free. If a lot does not sell, the seller pays no fee.

## How the fee is calculated

The fee is {{PLATFORM_FEE_PERCENT}} of the hammer price in USDC, rounded down to the smallest unit of USDC (six decimal places). It is paid in the same blockchain transaction in which the buyer pays and the token is transferred, directly to the fee address below. The seller receives the hammer price minus our fee and minus any creator royalty.

Fee address: {{TREASURY_WALLET}}

Example: hammer price 1,000 USDC. Our fee: 25 USDC. The seller receives 975 USDC, less any creator royalty. The buyer pays 1,000 USDC.

## Packs and AI credits

If packs are offered, the price is paid first. For an equal-value pack it goes to the seller in the same transaction that moves the card, less the same percentage fee. For a chance pack the price goes directly to the pack operator, with the same percentage fee as a separate part of the same payment, and the card follows in a second transaction that the operator signs. We never receive the price, so we cannot refund it if the operator does not deliver, and the network fees of both transactions are borne by us. AI credits are optional. 1 USDC buys 10 credits, and a draft costs one credit. You pay in one transaction that you sign, directly to the fee address above, and a credit that is not used because a draft failed is returned. On the test network the USDC has no value.

## Network fees

{{NETWORK_FEE_TEXT}} Creating a missing token account for a recipient costs a small one-off amount of SOL. The party that pays the network fees pays that too.

## Third-party fees

Some tokens carry a creator royalty. If so, it is paid out of the seller's proceeds in the same transaction. The vault operator may charge fees for storing or redeeming the physical card. Those fees are set by third parties and are not paid to us. Their terms govern.

## Taxes

We are a small business within the meaning of Section 19 UStG (German VAT Act) unless the legal notice states otherwise, and therefore show no VAT. You bear taxes on your sales or gains. We give no tax advice.

## Display of prices

Prices on Hammerprice are in USDC. A figure shown in SOL next to a price is an approximation from a public exchange rate and may differ from the rate at the time of the hammer. Only the USDC amount counts.

## Changes

We may change fees with at least 30 days' notice. They do not apply to lots already running in a room when they take effect. Details are in the [Terms](/legal/terms), sections 9 and 25.

Questions: {{OPERATOR_NAME}}, {{CONTACT_EMAIL}}.
