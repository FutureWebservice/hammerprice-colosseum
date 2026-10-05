---
title: "Privacy Policy"
description: "Which personal data Hammerprice processes, why, for how long, who receives it, and your rights."
---

# Privacy Policy

Version {{VERSION}}, last updated {{LAST_UPDATED}}

This policy explains which personal data we process when you use Hammerprice, why, on what legal basis, for how long, and to whom we disclose it. We keep the amount of data small: there is no sign-up with email and password, no tracking and no advertising. Your identity on Hammerprice is the public address of your wallet.

## 1. Controller

{{OPERATOR_NAME}}, owner {{OPERATOR_OWNER}}
{{OPERATOR_ADDRESS}}
Email: {{PRIVACY_CONTACT_EMAIL}}

We have not appointed a data protection officer because there is no legal obligation to do so (Section 38 of the German Federal Data Protection Act, BDSG). You can reach us on all privacy matters at the email address above.

## 2. The short version

- We do not ask for names, email addresses or payment details of buyers who only bid. We store a username, display name, short text, picture and the waiting-list email address only if you enter them yourself (3.13 and 3.14). There is no account to create: you sign in with your wallet.
- Your wallet address is a pseudonym, but it can be traced back to you with additional knowledge. We therefore treat it as personal data.
- We never have your keys or your money. We only see public addresses and messages you have signed.
- Data stored on the blockchain is public and technically cannot be deleted (section 9).
- We use no analytics or advertising tools and load no fonts or scripts from third-party servers. Your browser does connect directly to two kinds of third parties and then sends them your IP address: the delivery network that hosts card images, and Solana RPC servers (sections 4 and 6). Only if you press "Load live video" in a room that offers it does your browser also connect to a video server (section 3.10). We set no cookie that tracks you (section 11).
- Our functions run in the USA (Vercel, region iad1) and our database runs at Neon on AWS us-east-1, also in the USA. We do not host in the EU and do not claim to (sections 4 and 5).
- Optional features (room chat, AI functions, Telegram, live video, packs) process additional data only when you use them. Each has its own part of section 3 (3.8 to 3.14). The waiting list (3.13) stores your email address only if you enter it there, and your profile data (3.14) exists only if you enter it. The operator's non-public admin area (3.15) reads only data that we store anyway under this section. A feature that is switched off in the version you use processes nothing.

## 3. What data we process, why, and on what basis

### 3.1 Visiting the website (server logs)

When you open our pages, our hosting provider processes technically necessary connection data: IP address, date and time, requested address (URL), amount of data transferred, status code, referrer and browser identifier (user agent).

Purpose: delivering the website, security, defence against attacks and abuse (including counting requests per IP address and per wallet address in short time windows to limit abuse of bidding, sign-in and the test-funds function), error analysis.
Legal basis: Art. 6(1)(f) GDPR. Our legitimate interest is secure and stable operation.
Retention: {{LOG_RETENTION}}. After that, logs are deleted or anonymised, unless a security incident requires longer retention.

### 3.2 Connecting a wallet and signing messages

When you connect your wallet, we receive your public wallet address. To sign in, to register a paddle, to bid or to settle a sale, you sign a message or a transaction with your private key. The key never leaves your wallet. We only receive the message and the signature. Bids you place with a paddle key are signed in your browser by a temporary key that your wallet has authorised (see [Cookies and local storage](/legal/cookies)).

Data: wallet address, signed messages (content, for example room, lot, bid amount, time, one-time identifier), signatures, time, an internal profile number, a session cookie.
Purpose: identifying the bidder, verifying the validity of bids, running the auction, protecting against manipulation and duplicate bids.
Legal basis: Art. 6(1)(b) GDPR (the user agreement with you, see the Terms); for security and abuse prevention also Art. 6(1)(f) GDPR.
Retention: we keep bids and settlement data until the end of the third calendar year after the year in which the auction ended. Claims arising from bids and sales contracts can be asserted for that long (Sections 195, 199 of the German Civil Code, BGB). The session cookie expires after 12 hours. Single-use sign-in codes are valid for 5 minutes.

### 3.3 Bidding and settling the auction

When you bid, we verify your signature and read the USDC balance of your wallet address from the blockchain (section 6). We store the balance figure we read together with the bid. Bids, the hammer and the result are stored in our database. Bids and the bid history are visible to all participants in the room under a paddle number. The signed bids of a closed lot can be viewed by anyone and contain the bidder's wallet address. At the hammer, buyer and seller receive each other's wallet address, because the settlement is otherwise impossible. It is public on the blockchain anyway.

Purpose: running the auction and brokering the contract between buyer and seller.
Legal basis: Art. 6(1)(b) GDPR.
Retention: see 3.2.

### 3.4 Sellers and consignment

If you list cards as a seller, we also process the cards you list and the terms you set for each lot (reserve, opening price, increment). Your payout address is your own wallet address. We do not collect a name or an address for sellers. At present only private persons sell on the platform.

Purpose: performing the contract.
Legal basis: Art. 6(1)(b) GDPR.
Retention: as in 3.2.

### 3.5 Contact and reports

If you write to us by email or report content, we process your email address, your name (if given) and the content of your message. A notice under Art. 16 of Regulation (EU) 2022/2065 requires the notifier's name and email address (exception: notices concerning offences under Arts. 3 to 7 of Directive 2011/93/EU). We tell the notifier about the decision and, if we restrict content, the affected user. We name the notifier to the affected user only where strictly necessary to establish the illegality.

Purpose: handling your request or notice, enforcing the Terms, meeting legal obligations.
Legal basis: Art. 6(1)(b), (c) and (f) GDPR.
Retention: until the matter is closed, then three years to defend against claims (Art. 6(1)(f) GDPR); for notices with a decision, in line with the duty to document.

### 3.6 Strikes and blocking

If a settlement is not completed because of you, we record a strike against your profile. After the twentieth strike your paddle is suspended and your wallet is blocked (Terms, section 8). We also record the reason for a block.

Purpose: protecting other users and the integrity of the platform.
Legal basis: Art. 6(1)(b) and (f) GDPR.
Retention: as in 3.2.

### 3.7 Statutory retention

Where tax and commercial law require it (for example records of our fee income), we keep the relevant documents for the statutory periods (Section 147 of the German Fiscal Code AO, Section 257 of the German Commercial Code HGB; six, eight or ten years depending on the document). Legal basis: Art. 6(1)(c) GDPR.

### 3.8 Room chat (optional)

Some rooms have a chat. If you write in it, we store your message, the time, your bidder number and the wallet address behind it. A message is shown to others only after the room operator has approved it. Others see your bidder number, never your wallet, and next to it your display name if you set one in your profile (3.13). The room operator (the seller of the show, and for house shows the operator of the platform) sees your wallet address, so that they can review messages and mute or block bidders who abuse the chat. Links, email addresses, phone numbers, handles and wallet addresses are refused. Bots never post. If you report a message, we store the report with your wallet address. The operator sees the reason and the optional detail but not who reported.

Purpose: providing the chat you use, moderation, defence against abuse.
Legal basis: Art. 6(1)(b) GDPR for providing the chat, Art. 6(1)(f) GDPR for moderation and abuse defence.
Retention: messages 30 days after the show has ended and at the latest 90 days after posting. Reports are deleted with their message or at the latest after six months. Mutes and blocks 30 days after the show has ended. A daily job deletes them. The chat keeps no browser storage.

### 3.9 AI functions (optional, Google)

Three functions use an AI model from Google (Gemini Flash-Lite): an AI draft for the title and description of a lot in the sell wizard, an assistant in the room and in the sell wizard that picks the matching answer from our own FAQ, and the AI agent on the "AI" page, which searches lots, prepares a bid proposal and drafts a listing. They are used only when you press the button or write to the agent. Each of these functions needs a signed-in wallet; we process your session for that as in 3.2, but do not send it to Google. Every AI text is labelled as such, and the seller reviews a draft before it is used.

What goes to Google for one call: for a draft, the card details, the notes you typed and, if you add any, up to three photos (shrunk in your browser, without metadata). For a question, the text of the question (at most 300 characters) and the list of our FAQ questions. For the AI agent, your message and the names and numbers of the lots found last; we read the lots themselves from our database. We never send your wallet address, your IP address or your session. We store no prompts, no photos, no drafts, no questions and no conversation with the agent. We store the number of calls with model, tokens and cost, linked to your profile, and a credit ledger. Please do not enter personal data into notes or questions.

Credits: an AI draft costs one credit, and 1 USDC buys 10 credits. During the judging period credits can be switched off, and AI is then free. The AI agent never uses a credit. You pay in USDC to our fee address in one transaction that you sign. The ledger holds your profile, the number of credits and the reference of the payment. The payment is public on the blockchain. On the test network the USDC has no value.

Provider: we use the Gemini API of Google LLC. Our software can alternatively call Gemini on Vertex AI of Google Cloud. How Google handles the inputs, how long it keeps them and whether it uses them follows Google's terms for the service we use. The transfer to the USA relies on the safeguards named in section 5.

Purpose: performing the function you chose, cost control.
Legal basis: Art. 6(1)(b) GDPR.
Retention: the ledger and the usage entries as in 3.2.

### 3.10 Live video (optional)

A seller can switch on live video for a show. It is off unless the seller does it. A viewer's browser connects to the video server (currently stream.bonkstream.com) only after the viewer has pressed "Load live video" in the room. Before that click no connection is made. At the click, the video server sees your IP address and technical connection data. Your decision applies to that show and that browser session and ends with "Video off" or when you close the tab. The camera picture comes from the seller, not from us. We store no recording. We have not verified where the video server stands, who else operates it or whether it keeps access logs, so we do not state it here. If you do not want your IP address to reach it, do not press the button. Nothing in the auction depends on the picture: bids and the end of a lot follow the clock of our server.

Purpose: showing the seller's camera picture at your request.
Legal basis: Art. 6(1)(a) GDPR, your click, and Art. 49(1)(a) GDPR for the transfer. You can withdraw with "Video off".
Retention: we store nothing about it. How long the video server keeps data is not ours to state.

### 3.11 Telegram notifications (optional)

When you connect Telegram we store your Telegram chat id, the language and your choice of which messages you want, together with your profile (wallet address). We do not store your Telegram name, your phone number or the text of the messages we send. To avoid sending the same message twice we only store which notification we sent (type and internal id, up to 45 days). If you use Watch (alerts for the next lots of a room), we also store your profile, the show and the number of lots you still want, until the show ends or you send /unwatch. A one-time link token is stored only as a hash and for 10 minutes. Through the Telegram Bot API our servers send you messages about your bids and payments (lot, amount, deadline, a link to the room or to the receipt), if you ask for it when a show starts that you registered a bidder number for, and, if you are the operator of a room, about chat messages that wait for your approval. Telegram processes the messages and your chat id under its own privacy policy. Your browser only opens a link to t.me when you press "Connect Telegram". Connecting is voluntary and off unless the operator has switched the feature on. You can disconnect at any time on your profile page or with /stop in the chat, and we then delete the stored Telegram data. Telegram messages are an optional extra with no guarantee that they arrive in time; what your account and the room show is what counts.

Purpose: messages about your own bids, payments and shows, and chat approval for room operators, at your request.
Legal basis: Art. 6(1)(a) GDPR, your tap on "Connect Telegram" and Start, which you can withdraw at any time, and Art. 6(1)(b) GDPR for the messages about your own bids and sales.
Retention: until you disconnect; the markers of sent messages up to 45 days.

### 3.12 Packs and the random order of lots (optional)

Packs: a pack operator (an independent seller) offers real cards from a pool with published odds. In every pack Hammerprice provides the technology, is not the seller and does not receive the pack price: in an equal-value pack you pay the seller in the same transaction that moves the card, and in a chance pack you pay the operator directly and first and the operator delivers the card in a second transaction that they sign (Terms, section 22). To open a pack you confirm that you are 18 or older. We store your wallet address as the buyer, the time of that confirmation, the random seed your browser creates, the state of the purchase with the references of the payment and the delivery, the draw with its proof and the card drawn, and for a chance pack the delivery deadline and whether the operator delivered. The draw log and the proof page are public. They show the draw, the commitment to the pool and the buyer's wallet address, as the transaction does on the blockchain. The delivery record of an operator (how many sales were delivered, how many late, how many not delivered, and the median delivery time) is public too. The payment transaction carries a note with the draw number and a hash of the pool, which contains no personal data. The operator of the pack receives your wallet address, because the payment goes to it and the card moves from its wallet to yours. If an operator does not deliver, a strike is recorded on the operator's profile. We count your purchases per wallet and day to enforce a daily limit.

Purpose: performing the purchase you chose, a verifiable draw, protection of minors, abuse limits.
Legal basis: Art. 6(1)(b) GDPR, for the daily limit and the age confirmation also Art. 6(1)(f) GDPR.
Retention: as in 3.2.

Random order of lots: in house shows the platform can have the order of the lots drawn by a verifiable random draw (ECVRF). The draw uses a key of ours and a block hash of the blockchain, and its proof is public. It is written to the blockchain in two notes that contain lot numbers and hashes. Neither contains personal data.

Thank-you draw: after a house show, one paddle number can be drawn among the people who bid in it, with the same kind of draw. We use the paddle numbers of the bidders of that show, which are already stored under 3.2. The draw and its proof, which name paddle numbers and no wallet address or name, are public on the proof page. Purpose: the draw itself and its verifiability. Legal basis: Art. 6(1)(b) GDPR, as a courtesy of the auction you took part in, and Art. 6(1)(f) GDPR. Retention: as in 3.2.

### 3.13 Waiting list (optional)

If you enter your email address in the waiting list form on the start page and send it, we store the address (in lower case), the language of the page you used and the time. We use it only to tell you once that Hammerprice is reachable on the main network (mainnet), and we send you nothing else and pass the address on to nobody. The form has a hidden field that only automatic programs fill in; an entry with that field filled is not stored. To limit abuse we count the submissions per network address and hour in the same counters as for the other forms; the address is not stored with your entry. Entering an address already on the list changes nothing. The list is not shown to other visitors; only the operator can see it, with the wallet sign-in of the operator.

Purpose: telling you when Hammerprice is reachable on the main network.
Legal basis: Art. 6(1)(a) GDPR, your consent by sending the form, which you can withdraw at any time. Write to the address in section 1 and we delete the entry; withdrawal does not affect what happened before.
Retention: until you ask us to delete the entry, otherwise until the waiting list is closed, at the latest 24 months after you entered the address. There is no automatic deletion at present: the operator removes entries by hand in the admin area.

### 3.14 Your profile (optional)

On your profile page you can set a username, a display name, a short text (up to 160 characters) and a picture. All four are optional and you decide whether to fill them in. We store them in our database together with your profile (wallet address): the username (3 to 24 letters, digits or underscores; it must be unique, without regard to letter case), the display name, the short text, and the picture itself as an image file of up to 200 KB (png, jpeg or webp; we check the file type from the file itself, we do not accept SVG, and we do not remove or read metadata in it: the file is stored and shown exactly as you upload it, so remove hidden data such as a location before you upload). We do not analyse the picture, and we do not use it for any other purpose.

Where they show: your username, short text and picture are shown on your own profile page, which only you can open when you are signed in. The picture is also available at a web address that contains the number of your profile and no wallet address (for example `/api/avatar/<profile number>`); anyone who knows that address can load the picture, so please choose a picture you are happy to have seen. Your display name, if you set one, appears next to your chat messages together with your bidder number (3.8) and as the seller of your rooms. Bids, the bid log and the live view of a room always show your bidder number only. A name or text that contains a link, an email address, a handle, a phone number or a wallet address is refused, and so is a name that poses as the platform; the checks are automatic and cannot catch everything, and an operator can block a profile that is abused.

Purpose: letting you recognise your account, a name for chat and for your rooms if you want one, and abuse defence for those texts and pictures.
Legal basis: Art. 6(1)(a) GDPR, because you choose to enter them and can withdraw by clearing the field at any time; for abuse defence also Art. 6(1)(f) GDPR.
Retention and deletion: until you clear the field or press "Remove picture" on your profile page; the data is then deleted from our database. When a picture is replaced, the old file is overwritten. A change is logged with the name of the field only, never its content. If we block or delete an account, its picture is no longer served.

### 3.15 The operator's admin area (not public)

The operator has an admin area that no link on the website reaches, that is not in the sitemap, is blocked for search engines and answers like a page that does not exist for everyone except a few wallets set by the operator. There the operator sees data that we store anyway under this section 3: wallet addresses with profile name, strikes, bids, sales and settlements, chat messages and reports, the waiting list and counters of AI use. The operator can delete a waiting-list entry or download the list as a CSV file, reject a chat message and cancel a show that has not started. Each of these actions is logged with the operator's wallet, and never with the email address of a waiting-list entry.

Purpose: operation, support, abuse defence and carrying out your deletion requests.
Legal basis: Art. 6(1)(f) GDPR.
Retention: The area stores nothing itself. There is no automatic deletion of the log lines at present.

## 4. Recipients and processors

We only pass on personal data where necessary for the purposes above. With service providers who process data on our behalf we use the data processing agreements that the providers offer (Art. 28 GDPR).

{{RECIPIENTS_TABLE}}

Google (the Gemini API of Google LLC, or Gemini on Vertex AI of Google Cloud): only when you use the AI listing draft or the room assistant, and only while these functions are active on the site, our servers send the inputs of that one call to Google: for a draft the card details, your notes and, if you add any, up to three photos (shrunk in your browser, without metadata); for a question the text of the question. We do not send your wallet address, IP address or session. We store no inputs and no answers, only the number of calls and their cost. The legal basis is performing the function you chose (Art. 6(1)(b) GDPR). Please do not enter personal data.

Authorities, courts and advisers receive data only where there is a legal obligation or where we need to establish, exercise or defend legal claims.

## 5. Transfers to third countries

Several of our providers are based in the USA or may process data there, and our functions and database run in the USA (section 4). We rely on the following safeguards, depending on the provider:

- the European Commission's adequacy decision on the EU-US Data Privacy Framework (Art. 45 GDPR), where the provider is certified. Vercel Inc. states that it is certified under this framework;
- the European Commission's Standard Contractual Clauses (Art. 46(2)(c) GDPR), which Vercel and Neon provide for in their data processing agreements;
- for Google (the AI functions): the safeguards that Google provides in its terms for the service we use, namely certification under the EU-US Data Privacy Framework and Standard Contractual Clauses where they apply (Art. 45 and 46 GDPR). We use them only when you use an AI function;
- for the video server: your own decision. You press "Load live video" (Art. 49(1)(a) GDPR). We have not verified certifications or contract clauses of these providers;
- for the Solana RPC operators and the image delivery network we have not verified a certification or contract clauses. Your browser connects to them directly, and the transfer is necessary to provide the function you ask for, namely showing a lot and reading or sending a transaction (Art. 49(1)(b) GDPR).
- for Google (AI functions) we have not finally verified the safeguards for the transfer to the USA. The transfer is necessary to provide the function you chose (Art. 49(1)(b) GDPR).

Our own functions run at Vercel in the USA (region iad1) and our database at Neon on AWS us-east-1 (USA). We do not host in the EU and do not claim to. You can obtain a copy of the safeguards on request.

## 6. Wallet, settlement, the blockchain and images

Hammerprice works with a public blockchain (Solana). Your wallet runs in your own software (browser extension or app). We have no access to it. A sale is settled in one transaction that you and the other party sign with your own wallets. Our server adds the signature of our settlement authority, which only pays network fees, and sends the transaction to the network. In an auction we hold no funds and no key that could move them; the same holds for packs, where the payment goes to the pack operator and only our fee share goes to our fee address (Terms, section 22). The transaction is public on the blockchain.

To read blockchain data and to send transactions, your browser and our server use RPC services. Your browser connects directly to the RPC server configured for the selected network, currently the public Solana endpoint, and our server uses its own configured endpoints. The RPC provider sees your IP address and the addresses queried. Your wallet extension makes its own requests, which we do not control.

Your browser also loads card images directly from the servers that host the token metadata, currently Amazon CloudFront (delivery for Collector Crypt). Your IP address is transmitted to these servers. The legal basis is Art. 6(1)(f) GDPR: lots cannot be displayed without the images.

Links to a blockchain explorer (for example Solscan) open a third-party page only when you click them. We load nothing from them beforehand.

## 7. Automated decisions

The outcome of an auction follows fixed rules known in advance: when the closing time passes, the highest valid bid that meets the reserve price wins. This rule is applied automatically. It is part of the contract you enter into with us and the seller (Art. 22(2)(a) GDPR). Strikes for settlements that were not completed are also recorded automatically, and after the twentieth strike the paddle is suspended (Terms, section 8). A pack draw follows the published odds and the random value of a public proof. It decides which card comes out of the pack you chose to open and has no other effect on you (Art. 22(2)(a) GDPR). The same holds for a random lot order. We do not profile you. If you believe a result or a strike is wrong, write to us: a person will then review the matter.

## 8. What we do not do

We use no analytics, tracking, advertising or social media plugins, no external fonts and no cookies for advertising purposes. The only third parties your browser contacts directly are named in sections 3.10 and 6. No video from a third party is loaded before you click. We do not sell data. We do not process payments ourselves, so we handle no card data or bank details.

## 9. The blockchain and the right to erasure

Transactions on the Solana blockchain are public, permanent and stored by thousands of independent participants. Neither we nor you can alter or delete them. This also applies to wallet addresses that appear in transactions.

For that reason:

- We do not write names, email addresses or other plain personal data into transactions. The settlement transaction carries a short note with a fingerprint (hash) of the signed bid history. It does not reveal the bids and contains no name or email address, but the bids it covers are identified by wallet addresses, which are public anyway.
- What we store ourselves in our database, we delete upon your justified request, unless a retention duty or an overriding interest prevents it (section 10).
- We cannot intervene in the blockchain. A right to erasure under Art. 17 GDPR cannot be fulfilled there technically. If you do not want a permanent public link, use a wallet that is not connected to your identity and do not disclose who owns it.

The European Data Protection Board (EDPB) described this tension in its Guidelines 02/2025 on processing personal data through blockchain technologies. We follow them: as little personal data as possible on the chain, the rest in a database that can be erased.

## 10. Your rights

You have the following rights against us, provided the legal requirements are met:

- access (Art. 15 GDPR)
- rectification (Art. 16)
- erasure (Art. 17)
- restriction of processing (Art. 18)
- data portability (Art. 20)
- objection to processing based on Art. 6(1)(f) GDPR on grounds relating to your particular situation (Art. 21)
- withdrawal of consent with effect for the future (Art. 7(3)). We process on the basis of consent only where you decide it yourself: when you press "Load live video" (3.10).

Write to us at {{PRIVACY_CONTACT_EMAIL}}. So that we can match your request, give us the wallet address concerned and, if you wish, sign a short message so that we can be sure you are the holder. We reply within one month.

## 11. Cookies and local storage

We only store what is necessary for the use you request (Section 25(2) no. 2 TDDDG): your wallet provider choice, a session cookie after you sign in, the signing key of your paddle in session storage, the state of a hint, the number of a pack purchase you are completing, and your choice to load live video in this tab. The language is part of the address. We need no consent for this and show no banner. The exact list is on the page [Cookies and local storage](/legal/cookies).

## 12. Security

The connection to our website is encrypted with TLS. Access to database and servers is limited to what is necessary. We verify signatures on the server and do not trust anything the browser claims. Still, no system is perfectly secure. Never enter your seed phrase or private key on a website. We never ask for it.

## 13. Minors

Hammerprice is only for people aged 18 or over. For packs you confirm that you are 18 or older before every purchase. The AI functions are for adults too. We do not knowingly collect data from minors.

## 14. Data from sources other than you (Art. 14 GDPR)

We retrieve publicly available blockchain and inventory data (for example which wallet address holds a particular card). This includes wallet addresses and holdings. The sources are the public Solana blockchain and the public Collector Crypt catalogue. We also retrieve an exchange rate from CoinGecko, which involves no personal data. We use them to display cards and to check whether a seller may offer a card. Individually informing every data subject would be disproportionate (Art. 14(5)(b) GDPR); this policy is public.

## 15. Right to lodge a complaint with a supervisory authority

You have the right to lodge a complaint with a data protection supervisory authority (Art. 77 GDPR). The authority responsible for us is:

Sächsische Datenschutz- und Transparenzbeauftragte (Saxon Data Protection and Transparency Commissioner)
Maternistraße 17, 01067 Dresden, Germany
Postal address: Postfach 11 01 32, 01330 Dresden
Phone: +49 351 85471-101
Email: post@sdtb.sachsen.de
Web: www.datenschutz.sachsen.de

You can also contact the supervisory authority where you live.

## 16. Changes

We update this policy when our processing or the law changes. The current version is published here with a version number and date. We announce material changes on the website.
