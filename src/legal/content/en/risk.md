---
title: "Risk notice"
description: "What can go wrong with crypto-assets, stablecoins and blockchain settlement, and what you can do about it."
---

# Risk notice

Version {{VERSION}}, last updated {{LAST_UPDATED}}

{{NETWORK_MODE_NOTICE}}

Hammerprice works with crypto-assets and blockchain technology. That has advantages, but it brings risks you do not have with classic online auctions. Please read this page before you bid or sell. It is not investment advice.

## What Hammerprice is and is not

- We are a technical marketplace. We are neither seller nor buyer, neither a bank, nor a payment service provider, nor a custodian.
- In an auction we never hold your money, your cards or your keys, and we hold no key that could move them. A sale is one transaction that buyer and seller both sign. The same holds for packs, with a risk of its own: in a chance pack you pay the operator directly and first, we cannot refund you, and you rely on the operator to deliver the card (risk 13).
- We are not supervised by BaFin. There is no deposit guarantee and no investor compensation scheme.
- Where packs are offered, the card you get is drawn at random (risk 13). The only other random draw is the thank-you draw after a house show, which names one paddle number among the people who bid and awards no prize of value (Terms, section 2.4). We offer no other games of chance or random-draw formats.

## Your main risks

### 1. You alone are responsible for your keys

Whoever knows your seed phrase or private key can dispose of your wallet. Lost keys cannot be recovered by anyone, including us. Never enter your keys or seed phrase on a website or give them to anyone posing as support. We never ask for them. Check the address and content of every transaction before you sign.

### 2. Transactions are final

A confirmed blockchain transaction cannot be reversed. If you paid to the wrong address or confirmed the wrong amount, the money is usually gone. Bids with us are binding and cannot be withdrawn. Your USDC stay in your own wallet until the settlement and are not reserved. If you move them after a bid and cannot pay, the sale fails and you receive a strike (Terms, section 8).

### 3. Errors in smart contracts and third-party programs

We run no smart contract of our own. A settlement uses standard Solana programs that we do not operate or control: the token program for USDC and the Metaplex Core program for cards. They may contain errors, be attacked or be changed, and your wallet software may have faults. We check the transaction against the agreed amounts before it is sent, but we cannot rule out losses from errors in these programs.

### 4. Stablecoin risks

We use USDC, a stablecoin of the company Circle. Its value is pegged to the US dollar but can deviate from it. The issuer can block addresses or freeze balances, for example on an official order. The stability of USDC depends on the issuer and on legal frameworks we do not control.

### 5. Risk with the vault and the physical card

The card a token refers to is not with us but with a third party in a vault. Whether the card exists, in what condition it is, whether it is insured and how it can be redeemed is decided solely by the vault operator. If it fails, changes its terms or does not keep the card available, the token can lose its value. When the card is redeemed the token is destroyed, and fees and shipping costs can apply.

### 6. Authenticity and grading

Card condition, authenticity and grading come from the seller and from third parties (such as grading companies). We do not verify them. Counterfeit cards, wrong gradings and inaccurate descriptions are possible.

### 7. Price fluctuations and lack of liquidity

Prices of collectible cards fluctuate and can fall sharply. There is no guarantee that you can resell a card and no minimum price. Successful auctions in the past are no indication of future ones.

### 8. Technical risks

Network congestion, outages, delays, errors in wallets, browsers or at third parties can cause bids to arrive late or transactions to fail. Our service can also fail or be faulty. Hammerprice is a live beta in demonstration mode and has so far not been operated on the main network with real money, so errors are more likely than in a long-running service. A settlement needs both signatures within the settlement window. If you are a seller, stay online until it closes. Our settlement authority pays the network fees (see [Fees](/legal/fees)); if it fails or runs out of SOL for them, the settlement fails. If you register a paddle, your browser holds a key that can sign bids without a wallet popup, up to the maximum and until the time you authorised. Choose a low maximum.

### 9. Fraud and phishing

There are fake websites, wallet prompts and support profiles. Check the address of the website and open only links from trusted sources. If someone tells you to sign a transaction "for security" or to give your key, it is a scam.

### 10. Legal, tax and regulatory risks

Rules for crypto-assets change. Use may be restricted in your country. Gains and turnover can be taxable, and reporting and documentation duties may exist, also for us. We give no tax or legal advice. Consult an adviser.

### 11. The blockchain is public

Transactions are public and permanent. Anyone who can link your wallet address to your identity sees your purchases, sales and holdings. See the [Privacy Policy](/legal/datenschutz).

### 12. In a dispute there is no central arbiter

Sales contracts exist between buyer and seller. We do not decide on defects and refund nothing, not even the price of a chance pack whose operator did not deliver the card (risk 13). You must enforce your claims against your counterparty yourself. How we handle reports is described under [Contact and reports](/legal/dsa-contact).

### 13. Packs: the card is drawn at random

If packs are offered, opening one means paying a price for a card that is drawn at random from a pool. You can receive a card that is worth less than the price you paid. The listed value of a card is the operator's own figure, not a promise of a price. The odds and the whole pool are shown before you buy and the draw can be recomputed, but nothing guarantees a result. Packs are for adults only, you confirm that you are 18 or older, and there is a daily limit per wallet. Open packs only with money you can afford to lose, and stop if you notice that you cannot. There are two kinds of pack. In a chance pack you pay the independent pack operator directly and first: Hammerprice never receives your payment, the card is drawn only after the payment is final, and the operator must then deliver it in a second transaction that the operator signs, within a deadline (24 hours after the draw unless set otherwise). Because Hammerprice holds no money it cannot refund you. If the operator does not deliver, or moves the drawn card away, the sale is marked as not delivered, the operator gets a strike and the pack is paused, but you do not get your money back from us: you must claim against the operator yourself, with the payment and the proof of the draw that we show you. Check the operator's public delivery record on the pack page before you pay, and pay only what you can afford to lose. In an equal-value pack every card has the same listed value: you pay the seller and the card moves from the seller's wallet to yours in one transaction, and Hammerprice only provides the technology. Whether an operator really owns the cards and describes them truthfully is the operator's responsibility, which the system checks only in part (the cards are checked against the operator's wallet when a pack is made and when a card is drawn, and an equal-value transaction fails if the seller does not hold the card).

### 14. AI functions, Telegram, live video and chat

AI drafts and assistant answers can be wrong. Check every text before you rely on it. The assistant gives no legal, tax or investment advice. The AI agent can pick the wrong lots or suggest an amount you do not want; it never bids itself, so check every suggestion before you sign. Telegram messages can arrive late or not at all; do not rely on them alone to learn that a lot is ending. If you press "Load live video", the video server sees your IP address, and the picture can be late or missing. Chat messages are approved by the room operator before others see them, and the operator sees your wallet address.

## What you can do

- Risk only what you can afford to lose.
- Use a wallet dedicated to Hammerprice and hold only the amount you need there.
- Read the lot description, seller status and grading carefully.
- Check every signature request. Decline unclear ones.
- Back up your seed phrase offline and share it with no one.

Questions to {{OPERATOR_NAME}}: {{CONTACT_EMAIL}}.
