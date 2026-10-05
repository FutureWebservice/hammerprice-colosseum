/**
 * What the site stores in the browser and whom it talks to, as DATA. The cookies page and the privacy
 * page print these tables (`{{STORAGE_TABLE}}`, `{{RECIPIENTS_TABLE}}`), and src/legal/__tests__/audit.test.ts
 * greps the source for every storage key and every host, so a key or a third party that nobody wrote down
 * here fails the build of the tests instead of silently making the texts false.
 *
 * Built from a grep of the source on 2026-09-30 plus the keys added later
 * (hp_session from AUTH, the paddle session key from ROOM/AUTH).
 */
import type { Locale } from './../lib/i18n/config';
import type { PlaceholderValues } from './config';

type L = Record<Locale, string>;

export interface StorageEntry {
  /** Exact key, or a prefix pattern for keys that carry an id. */
  name: string;
  /** Matches the literal key found in the source. */
  match: RegExp;
  kind: L;
  purpose: L;
  when: L;
  duration: L;
  basis: L;
}

const TDDDG = 'Sec. 25(2) no. 2 TDDDG';
const TDDDG_DE = '§ 25 Abs. 2 Nr. 2 TDDDG';

export const STORAGE: readonly StorageEntry[] = [
  {
    name: 'walletName',
    match: /^walletName$/,
    kind: { de: 'Local Storage', en: 'Local storage' },
    purpose: {
      de: 'Merkt, mit welchem Wallet-Anbieter Sie sich verbunden haben (der Name der Wallet-Erweiterung), damit die Verbindung nach dem Neuladen wiederhergestellt werden kann. Enthält keine Adresse und keinen Schlüssel. Der Schlüsselname stammt vom Wallet-Adapter, den wir einsetzen.',
      en: 'Remembers which wallet provider you connected with (the name of the wallet extension), so the connection can be restored after a reload. Contains no address and no key. The key name comes from the wallet adapter we use.',
    },
    when: { de: 'Wenn Sie ein Wallet auswählen', en: 'When you select a wallet' },
    duration: { de: 'bis Sie die Verbindung trennen oder den Speicher löschen', en: 'until you disconnect or clear storage' },
    basis: { de: `${TDDDG_DE}, Art. 6 Abs. 1 lit. b DSGVO`, en: `${TDDDG}, Art. 6(1)(b) GDPR` },
  },
  {
    name: 'hp_session',
    match: /^hp_session$/,
    kind: { de: 'Cookie (eigene Domain, HttpOnly, Secure, SameSite=Lax)', en: 'Cookie (own domain, HttpOnly, Secure, SameSite=Lax)' },
    purpose: {
      de: 'Hält Sie angemeldet, nachdem Sie die Anmeldenachricht mit Ihrem Wallet signiert haben. Enthält ein von uns signiertes Token mit Ihrer Wallet-Adresse, einer internen Profilnummer und Ausstellungs- und Ablaufzeit. Ohne dieses Cookie müssten Sie für jede Aktion neu signieren.',
      en: 'Keeps you signed in after you have signed the sign-in message with your wallet. Holds a token signed by us with your wallet address, an internal profile number and the issue and expiry time. Without it you would have to sign again for every action.',
    },
    when: { de: 'Wenn Sie sich mit Ihrem Wallet anmelden', en: 'When you sign in with your wallet' },
    duration: { de: '12 Stunden', en: '12 hours' },
    basis: { de: `${TDDDG_DE}, Art. 6 Abs. 1 lit. b DSGVO`, en: `${TDDDG}, Art. 6(1)(b) GDPR` },
  },
  {
    name: 'hp:paddle:…',
    match: /^hp[:_-]paddle/,
    kind: { de: 'Session Storage', en: 'Session storage' },
    purpose: {
      de: 'Der Signierschlüssel Ihres Paddles: ein Schlüssel, den Ihr Browser für einen Raum erzeugt und den Ihr Wallet einmal freigegeben hat, damit Gebote ohne Wallet-Fenster signiert werden können. Begrenzt durch den Höchstbetrag und die Geltungsdauer, die Sie mitsigniert haben. Er ist kein Schlüssel Ihres Wallets und kann nichts außer Geboten in diesem Raum signieren.',
      en: 'The signing key of your paddle: a key your browser creates for one room and your wallet authorised once, so that bids can be signed without a wallet popup. Limited by the maximum amount and the validity you signed along with it. It is not a key of your wallet and can sign nothing except bids in this room.',
    },
    when: { de: 'Wenn Sie in einem Raum ein Paddle registrieren', en: 'When you register a paddle in a room' },
    duration: { de: 'bis zum Schließen des Tabs, höchstens bis zum Ablauf der Freigabe (höchstens 6 Stunden in einer Live-Show, höchstens 7 Tage in einer Zeitauktion)', en: 'until the tab is closed, at most until the authorisation expires (at most 6 hours in a live show, at most 7 days in a timed auction)' },
    basis: { de: `${TDDDG_DE}, Art. 6 Abs. 1 lit. b DSGVO`, en: `${TDDDG}, Art. 6(1)(b) GDPR` },
  },
  {
    name: 'hp.signin',
    match: /^hp\.signin$/,
    kind: { de: 'Session Storage', en: 'Session storage' },
    purpose: {
      de: 'Merkt sich, dass Sie auf Anmelden getippt haben und Ihr Wallet gefragt wurde: Ihre Wallet-Adresse, den Zeitpunkt und ob die Anmeldung schon einmal fortgesetzt wurde. So kann die Seite die Anmeldung fortsetzen, wenn Sie vom Wallet-App-Wechsel auf dem Handy zurückkommen. Enthält keinen Schlüssel und keine Signatur.',
      en: 'Remembers that you tapped Sign in and your wallet was asked: your wallet address, the time and whether the sign-in was already picked up once. This lets the page continue the sign-in when you come back from the wallet app on a phone. Contains no key and no signature.',
    },
    when: { de: 'Wenn Sie auf Anmelden tippen', en: 'When you tap Sign in' },
    duration: { de: 'bis die Anmeldung abgeschlossen ist, spätestens bis zum Schließen des Tabs (nach 3 Minuten wird sie ohnehin ignoriert)', en: 'until the sign-in is done, at most until the tab is closed (after 3 minutes it is ignored anyway)' },
    basis: { de: `${TDDDG_DE}, Art. 6 Abs. 1 lit. b DSGVO`, en: `${TDDDG}, Art. 6(1)(b) GDPR` },
  },
  {
    name: 'hp.autosign',
    match: /^hp\.autosign$/,
    kind: { de: 'Session Storage', en: 'Session storage' },
    purpose: {
      de: 'Merkt sich, für welche Wallet-Adresse die Seite in diesem Tab schon einmal von selbst zur Anmeldung aufgefordert hat, damit Ihr Wallet nach einer Ablehnung nicht bei jedem Neuladen erneut fragt. Enthält nur die öffentliche Wallet-Adresse, keinen Schlüssel und keine Signatur.',
      en: 'Remembers for which wallet address the page already asked for a sign-in by itself in this tab, so that your wallet is not asked again on every reload after you declined. Contains only the public wallet address, no key and no signature.',
    },
    when: { de: 'Wenn ein verbundenes Wallet ohne Sitzung zur Anmeldung aufgefordert wird', en: 'When a connected wallet without a session is asked to sign in' },
    duration: { de: 'bis zum Schließen des Tabs', en: 'until the tab is closed' },
    basis: { de: `${TDDDG_DE}, Art. 6 Abs. 1 lit. b DSGVO`, en: `${TDDDG}, Art. 6(1)(b) GDPR` },
  },
  {
    name: 'hp.sell.recent',
    match: /^hp\.sell\.recent$/,
    kind: { de: 'Local Storage', en: 'Local storage' },
    purpose: {
      de: 'Merkt sich die Räume (Nummer, Titel, Zeitpunkt), die Sie in diesem Browser als Verkäufer angelegt haben, damit Sie die Verwaltungsseite wiederfinden. Enthält keine Adresse und keinen Schlüssel. Die Verwaltungsseite fragt immer den Server, der prüft, ob Sie der Verkäufer sind.',
      en: 'Remembers the rooms (id, title, time) you created as a seller in this browser, so you can find the manage page again. Contains no address and no key. The manage page always asks the server, which checks that you are the seller.',
    },
    when: { de: 'Wenn Sie einen Raum anlegen', en: 'When you create a room' },
    duration: { de: 'bis Sie den Speicher löschen (höchstens 10 Einträge)', en: 'until you clear storage (at most 10 entries)' },
    basis: { de: `${TDDDG_DE}, Art. 6 Abs. 1 lit. b DSGVO`, en: `${TDDDG}, Art. 6(1)(b) GDPR` },
  },
  {
    name: 'hp.video.…',
    match: /^hp\.video\./,
    kind: { de: 'Session Storage', en: 'Session storage' },
    purpose: {
      de: 'Merkt sich, dass Sie in einem Raum auf „Live-Video laden“ geklickt haben, damit das Bild nach dem Neuladen der Seite nicht erneut bestätigt werden muss. Der Schlüssel enthält die Nummer des Raums, der Wert nur 1. Ohne Ihren Klick wird keine Verbindung zum Video-Server aufgebaut.',
      en: 'Remembers that you pressed "Load live video" in a room, so the picture does not have to be confirmed again after a reload. The key contains the number of the room, the value is only 1. Without your click no connection to the video server is made.',
    },
    when: { de: 'Wenn Sie „Live-Video laden“ klicken', en: 'When you press "Load live video"' },
    duration: { de: 'bis zum Schließen des Tabs oder bis Sie „Video aus“ wählen', en: 'until the tab is closed or you choose "Video off"' },
    basis: { de: `${TDDDG_DE}, Art. 6 Abs. 1 lit. b DSGVO`, en: `${TDDDG}, Art. 6(1)(b) GDPR` },
  },
  {
    name: 'hp.pack.…',
    match: /^hp\.pack\./,
    kind: { de: 'Session Storage', en: 'Session storage' },
    purpose: {
      de: 'Merkt sich in diesem Tab, welchen Pack-Kauf Sie gerade abschließen (Schlüssel mit der Nummer des Packs, Wert die Nummer der Ziehung) und ob die gezogene Karte Ihnen schon gezeigt wurde (Schlüssel mit der Nummer der Ziehung, Wert 1). So findet ein Neuladen mitten im Kauf den Kauf wieder und die Karte wird nicht zweimal enthüllt. Enthält keine Adresse und keinen Schlüssel.',
      en: 'Remembers in this tab which pack purchase you are completing (key with the pack number, value the draw number) and whether the drawn card has already been shown to you (key with the draw number, value 1). A reload in the middle of a purchase finds the purchase again, and the card is not revealed twice. Contains no address and no key.',
    },
    when: { de: 'Wenn Sie einen Pack kaufen', en: 'When you buy a pack' },
    duration: { de: 'bis zum Schließen des Tabs', en: 'until the tab is closed' },
    basis: { de: `${TDDDG_DE}, Art. 6 Abs. 1 lit. b DSGVO`, en: `${TDDDG}, Art. 6(1)(b) GDPR` },
  },
  {
    name: 'hp.tour.v1',
    match: /^hp\.tour\.v1$/,
    kind: { de: 'Local Storage', en: 'Local storage' },
    purpose: {
      de: 'Merkt sich, dass Ihnen der kurze Rundgang durch den Auktionsraum schon gezeigt wurde, damit er nur einmal erscheint. Enthält nur den Wert 1, keine Adresse und keinen Schlüssel.',
      en: 'Remembers that you have already been shown the short tour of the auction room, so it appears only once. Contains only the value 1, no address and no key.',
    },
    when: { de: 'Wenn der Rundgang zum ersten Mal startet', en: 'When the tour starts for the first time' },
    duration: { de: 'bis Sie den Speicher löschen', en: 'until you clear storage' },
    basis: { de: `${TDDDG_DE}, Art. 6 Abs. 1 lit. b DSGVO`, en: `${TDDDG}, Art. 6(1)(b) GDPR` },
  },
  {
    name: 'hp:ai-agent:v1:…',
    match: /^hp:ai-agent:v1:/,
    kind: { de: 'Local Storage', en: 'Local storage' },
    purpose: {
      de: 'Speichert Ihr Gespräch mit dem KI-Agenten (Ihre Nachrichten und seine Antworten samt Karten) nur in diesem Browser, damit es beim Wiederkommen und zwischen der KI-Seite und dem Assistenten im Raum fortgesetzt werden kann. Der Schlüsselname enthält die Adresse Ihres Wallets, damit ein anderes Wallet in diesem Browser das Gespräch nicht sieht. Der Inhalt wird nie an uns oder andere gesendet. Höchstens die letzten 200 Nachrichten und etwa 300 KB.',
      en: 'Keeps your conversation with the AI agent (your messages and its answers with their cards) in this browser only, so it can continue when you come back and between the AI page and the assistant in the room. The key name contains your wallet address, so another wallet in this browser does not see the conversation. The content is never sent to us or anyone else. At most the last 200 messages and about 300 KB.',
    },
    when: { de: 'Wenn Sie mit angemeldetem Wallet eine Nachricht an den KI-Agenten senden', en: 'When you send a message to the AI agent with a signed-in wallet' },
    duration: { de: 'bis Sie „Chat zurücksetzen“ klicken oder den Speicher löschen', en: 'until you click "Reset chat" or clear storage' },
    basis: { de: `${TDDDG_DE}, Art. 6 Abs. 1 lit. b DSGVO`, en: `${TDDDG}, Art. 6(1)(b) GDPR` },
  },
  {
    name: 'hp.hint.…, hp.adv.…',
    match: /^hp\.(hint|adv)\./,
    kind: { de: 'Session Storage', en: 'Session storage' },
    purpose: {
      de: 'Merkt sich für diese Sitzung, ob Sie einen Hinweis zur Wallet-Bestätigung schon gesehen haben und welche Abschnitte unter „Erweitert“ Sie geöffnet haben. Enthält nur den Wert 0 oder 1, keine Adresse und keinen Schlüssel.',
      en: 'Remembers for this session whether you have already seen a note about a wallet confirmation and which "Advanced options" sections you opened. Contains only the value 0 or 1, no address and no key.',
    },
    when: { de: 'Wenn Sie eine Wallet-Bestätigung abschließen oder einen Abschnitt öffnen oder schließen', en: 'When you complete a wallet confirmation or open or close a section' },
    duration: { de: 'bis zum Schließen des Tabs', en: 'until the tab is closed' },
    basis: { de: `${TDDDG_DE}, Art. 6 Abs. 1 lit. b DSGVO`, en: `${TDDDG}, Art. 6(1)(b) GDPR` },
  },
];

/** Keys found in the source that are dead code or not ours. Listed so the audit can say why they are not in the table. */
export const STORAGE_NOT_SET: Record<string, string> = {
  NEXT_LOCALE: 'src/lib/i18n/index.ts defines saveUserLocale, but nothing calls it and the router sets no locale cookie (localeCookie: false). Delete it.',
  'hp:pack::': 'src/lib/packs/commit.ts: the prefix of the memo text hp:pack:<draw id>:<pool hash> that is written into the pack payment transaction on the blockchain. It is not browser storage.',
};

const esc = (s: string) => s.replace(/\|/g, '\\|');

export function storageTable(locale: Locale): string {
  const head =
    locale === 'de'
      ? ['Name', 'Art', 'Zweck', 'Wann gesetzt', 'Dauer', 'Rechtsgrundlage']
      : ['Name', 'Type', 'Purpose', 'When set', 'Duration', 'Legal basis'];
  const rows = STORAGE.map((e) => [`\`${e.name}\``, e.kind[locale], e.purpose[locale], e.when[locale], e.duration[locale], e.basis[locale]]);
  return [head, head.map(() => '---'), ...rows].map((r) => `| ${r.map(esc).join(' | ')} |`).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Recipients and hosts
// ---------------------------------------------------------------------------------------------

export type HostKind =
  | 'first-party' // our own origin
  | 'browser' // the visitor's browser connects directly: the visitor's IP address reaches this host
  | 'server' // only our servers connect; no visitor data is sent
  | 'link' // a link the visitor may click; nothing is loaded before the click
  | 'dormant' // in the source, but off unless configured; nothing is loaded by default
  | 'neutral'; // a namespace string, not a connection

/** Every host that appears in src/**. audit.test.ts fails on a host that is not here. */
export const HOSTS: Record<string, HostKind> = {
  'hammerprice-earn.vercel.app': 'first-party',
  'localhost': 'first-party',
  'www.w3.org': 'neutral',
  'api.devnet.solana.com': 'browser',
  'api.mainnet-beta.solana.com': 'browser',
  'api.testnet.solana.com': 'browser',
  'devnet.helius-rpc.com': 'browser',
  'mainnet.helius-rpc.com': 'browser',
  'api.collectorcrypt.com': 'server',
  'dev-api.collectorcrypt.com': 'server',
  'api.coingecko.com': 'server',
  'fonts.googleapis.com': 'server', // preview image and icon rendering only; the site's own fonts are self-hosted
  'solscan.io': 'link',
  'schema.org': 'neutral', // a JSON-LD vocabulary namespace, not a connection
  'github.com': 'link', // link to the owner's GitHub page; nothing loads before a click
  'phantom.com': 'link',
  'phantom.app': 'link', // wallet install links in the room's wallet sheet; nothing loads before a click
  'solflare.com': 'link',
  'backpack.app': 'link',
  'lite-api.jup.ag': 'server', // SOL price fallback, called by our servers only
  'api.coinbase.com': 'server', // SOL price fallback, called by our servers only
  'explorer.solana.com': 'link',
  'livepeercdn.studio': 'dormant', // the inherited video fallback; nothing loads it unless a provider is configured
  'd1xpxki1g4htqu.cloudfront.net': 'browser', // card images, Collector Crypt's CloudFront distribution
  // AI features (FEATURE_AI, off by default): called by our servers only, and only when a person uses the AI draft or the assistant. The privacy text must name Google.
  'generativelanguage.googleapis.com': 'server', // Gemini API (AI_PROVIDER=gemini-api)
  'aiplatform.googleapis.com': 'server', // Vertex AI (AI_PROVIDER=vertex)
  'oauth2.googleapis.com': 'server', // service account token exchange (AI_PROVIDER=vertex)
  'www.googleapis.com': 'neutral', // the OAuth scope name in that token request, not a connection
  // Telegram notifications (FEATURE_TELEGRAM, off by default, opt-in per user): called by our servers only (the Bot API, with the chat id the user linked), and a link the user may tap to open the bot. The privacy text must name Telegram.
  'api.telegram.org': 'server',
  't.me': 'link', // the one-time deep link https://t.me/<bot>?start=<token>; nothing loads before the user taps it
  // Optional live video (FEATURE_VIDEO, off by default, off per show unless the seller ticks it): the viewer's browser connects to the video host only after the viewer clicks "Load live video". The host name comes from the environment (MEDIA_SERVER_URL).
  'stream.bonkstream.com': 'browser',
};

export interface Recipient {
  name: L;
  task: L;
  place: L | ((v: PlaceholderValues) => string);
}

/** Section 4 of the privacy text. One row per party that receives visitor or user data. */
const RECIPIENTS: readonly Recipient[] = [
  {
    name: { de: 'Vercel Inc., USA', en: 'Vercel Inc., USA' },
    task: {
      de: 'Hosting und Auslieferung der Website, serverseitige Funktionen, Server-Logdaten',
      en: 'Hosting and delivery of the website, server-side functions, server logs',
    },
    place: (v) => v.HOSTING_REGION,
  },
  {
    name: { de: 'Neon, Inc., USA (Datenbankdienst)', en: 'Neon, Inc., USA (database service)' },
    task: {
      de: 'Speicherung der Datenbank (Gebote, Lose, Paddles, Abwicklungen, Profile, Warteliste)',
      en: 'Storage of the database (bids, lots, paddles, settlements, profiles, waiting list)',
    },
    place: (v) => v.DB_REGION,
  },
  {
    name: { de: 'Betreiber der Solana-RPC-Dienste: öffentlicher Solana-Endpunkt und Helius Blockchain Technologies, Inc., USA', en: 'Operators of the Solana RPC services: the public Solana endpoint and Helius Blockchain Technologies, Inc., USA' },
    task: {
      de: 'Abfrage von Blockchain-Daten (Guthaben, Besitz von Token) und Übermittlung von Transaktionen. Ihr Browser verbindet sich direkt mit dem eingestellten öffentlichen Endpunkt und übermittelt dabei Ihre IP-Adresse (Abschnitt 6).',
      en: 'Reading blockchain data (balances, token ownership) and submitting transactions. Your browser connects directly to the configured public endpoint and thereby transmits your IP address (section 6).',
    },
    place: { de: 'USA und weitere Länder', en: 'USA and other countries' },
  },
  {
    name: { de: 'Amazon CloudFront (Auslieferung der Kartenbilder für Collector Crypt)', en: 'Amazon CloudFront (image delivery for Collector Crypt)' },
    task: {
      de: 'Ihr Browser lädt Kartenbilder direkt von dort und übermittelt dabei Ihre IP-Adresse (Abschnitt 6).',
      en: 'Your browser loads card images directly from there and thereby transmits your IP address (section 6).',
    },
    place: { de: 'USA und weitere Länder', en: 'USA and other countries' },
  },
  {
    name: { de: 'Google (Gemini API von Google LLC, optional Gemini auf Vertex AI von Google Cloud)', en: 'Google (the Gemini API of Google LLC, optionally Gemini on Vertex AI of Google Cloud)' },
    task: {
      de: 'Nur wenn Sie die KI-Funktionen benutzen (KI-Entwurf für eine Beschreibung, KI-Assistent): Unsere Server übermitteln die Eingaben dieses einen Aufrufs (Abschnitt 3.9). Wallet-Adresse, IP-Adresse und Sitzung übermitteln wir nicht.',
      en: 'Only when you use the AI features (AI draft for a description, AI assistant): our servers send the inputs of that one call (section 3.9). We do not send your wallet address, IP address or session.',
    },
    place: { de: 'USA und weitere Länder', en: 'USA and other countries' },
  },
  {
    name: { de: 'Video-Server von Bonkstream (stream.bonkstream.com), optional', en: 'Bonkstream video server (stream.bonkstream.com), optional' },
    task: {
      de: 'Nur wenn der Verkäufer Video für seine Show eingeschaltet hat und Sie im Raum auf „Live-Video laden“ klicken: Ihr Browser verbindet sich dann direkt mit diesem Server und übermittelt dabei Ihre IP-Adresse (Abschnitt 3.10).',
      en: 'Only if the seller switched video on for their show and you press "Load live video" in the room: your browser then connects directly to this server and thereby transmits your IP address (section 3.10).',
    },
    place: { de: 'Standort nicht von uns geprüft (Abschnitt 3.10)', en: 'location not verified by us (section 3.10)' },
  },
  {
    name: { de: 'Telegram Messenger (Bot-Schnittstelle), optional', en: 'Telegram Messenger (Bot API), optional' },
    task: {
      de: 'Nur wenn Sie Telegram verbinden: Unsere Server senden die von Ihnen gewünschten Nachrichten; Telegram erhält Ihre Chat-ID und den Nachrichtentext (Abschnitt 3.11).',
      en: 'Only if you connect Telegram: our servers send the messages you asked for; Telegram receives your chat id and the message text (section 3.11).',
    },
    place: { de: 'wie von Telegram angegeben', en: 'as stated by Telegram' },
  },
  {
    name: { de: 'Collector Crypt und CoinGecko', en: 'Collector Crypt and CoinGecko' },
    task: {
      de: 'Unsere Server rufen öffentliche Katalogdaten (Karten) und einen Umrechnungskurs ab. Wir übermitteln dabei keine Nutzerdaten.',
      en: 'Our servers retrieve public catalogue data (cards) and an exchange rate. We send no user data when we do so.',
    },
    place: { de: 'wie vom Anbieter angegeben', en: 'as stated by the provider' },
  },
];

export function recipientsTable(locale: Locale, values: PlaceholderValues): string {
  const head = locale === 'de' ? ['Empfänger', 'Aufgabe', 'Sitz der Verarbeitung'] : ['Recipient', 'Task', 'Place of processing'];
  const rows = RECIPIENTS.map((r) => [r.name[locale], r.task[locale], (typeof r.place === 'function' ? r.place(values) : r.place[locale])]);
  return [head, head.map(() => '---'), ...rows].map((r) => `| ${r.map(esc).join(' | ')} |`).join('\n');
}
