---
title: "Datenschutzerklärung"
description: "Welche personenbezogenen Daten Hammerprice verarbeitet, wozu, wie lange, wer sie erhält und welche Rechte Sie haben."
---

# Datenschutzerklärung

Version {{VERSION}}, Stand {{LAST_UPDATED}}

Diese Erklärung sagt Ihnen, welche personenbezogenen Daten wir verarbeiten, wenn Sie Hammerprice nutzen, wozu, auf welcher Rechtsgrundlage, wie lange und an wen wir sie weitergeben. Wir halten die Datenmenge klein: Es gibt keine Registrierung mit E-Mail und Passwort, kein Tracking und keine Werbung. Ihre Identität bei Hammerprice ist die öffentliche Adresse Ihres Wallets.

## 1. Verantwortlicher

{{OPERATOR_NAME}}, Inhaber {{OPERATOR_OWNER}}
{{OPERATOR_ADDRESS}}
E-Mail: {{PRIVACY_CONTACT_EMAIL}}

Einen Datenschutzbeauftragten haben wir nicht benannt, weil keine gesetzliche Pflicht dazu besteht (§ 38 BDSG). Für alle Datenschutzfragen erreichen Sie uns unter der genannten E-Mail-Adresse.

## 2. Das Wichtigste in Kürze

- Wir verlangen keine Namen, E-Mail-Adressen oder Zahlungsdaten von Käufern, die nur mitbieten. Benutzername, Anzeigename, Kurztext, Bild und die E-Mail-Adresse der Warteliste speichern wir nur, wenn Sie sie selbst eingeben (3.13 und 3.14). Sie müssen kein Konto anlegen: Sie melden sich mit Ihrem Wallet an.
- Ihre Wallet-Adresse ist ein Pseudonym, kann aber mit Zusatzwissen auf Sie zurückführbar sein. Wir behandeln sie deshalb als personenbezogenes Datum.
- Ihre Schlüssel und Ihr Geld haben wir nie. Wir sehen nur öffentliche Adressen und von Ihnen signierte Nachrichten.
- Auf der Blockchain gespeicherte Daten sind öffentlich und lassen sich technisch nicht löschen (Abschnitt 9).
- Wir setzen keine Analyse- oder Werbe-Tools ein und laden keine Schriften oder Skripte von Drittservern. Ihr Browser verbindet sich aber direkt mit zwei Arten von Dritten und übermittelt ihnen dabei Ihre IP-Adresse: dem Auslieferungsnetz, das Kartenbilder bereitstellt, und Solana-RPC-Servern (Abschnitte 4 und 6). Nur wenn Sie in einem Raum, der es anbietet, auf „Live-Video laden“ klicken, verbindet sich Ihr Browser außerdem mit einem Video-Server (Abschnitt 3.10). Wir setzen kein Cookie, das Sie verfolgt (Abschnitt 11).
- Unsere Funktionen laufen in den USA (Vercel, Region iad1) und unsere Datenbank bei Neon auf AWS us-east-1, ebenfalls in den USA. Wir hosten nicht in der EU und behaupten das auch nicht (Abschnitte 4 und 5).
- Optionale Funktionen (Raum-Chat, KI-Funktionen, Telegram, Live-Video, Packs) verarbeiten zusätzliche Daten nur, wenn Sie sie nutzen. Jede hat einen eigenen Teil in Abschnitt 3 (3.8 bis 3.14). Die Warteliste (3.13) speichert nur Ihre E-Mail-Adresse, wenn Sie sie dort eintragen, und Ihre Profildaten (3.14) gibt es nur, wenn Sie sie eingeben. Der nicht öffentliche Verwaltungsbereich des Betreibers (3.15) liest nur Daten, die wir ohnehin nach diesem Abschnitt speichern. Eine Funktion, die in der von Ihnen genutzten Version ausgeschaltet ist, verarbeitet nichts.

## 3. Welche Daten wir verarbeiten, wozu und auf welcher Grundlage

### 3.1 Besuch der Website (Server-Logdaten)

Beim Aufruf der Seiten verarbeitet unser Hosting-Anbieter technisch notwendige Verbindungsdaten: IP-Adresse, Datum und Uhrzeit, aufgerufene Adresse (URL), übertragene Datenmenge, Statuscode, Referrer und Browserkennung (User-Agent).

Zweck: Auslieferung der Website, Sicherheit, Abwehr von Angriffen und Missbrauch (einschließlich des Zählens von Anfragen je IP-Adresse und je Wallet-Adresse in kurzen Zeitfenstern, um Missbrauch von Geboten, Anmeldung und Testguthaben-Funktion zu begrenzen), Fehleranalyse.
Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes Interesse ist der sichere und stabile Betrieb.
Speicherdauer: {{LOG_RETENTION}}. Danach werden die Logdaten gelöscht oder anonymisiert, außer ein Sicherheitsvorfall erfordert längere Aufbewahrung.

### 3.2 Wallet verbinden und Nachrichten signieren

Wenn Sie Ihr Wallet verbinden, erhalten wir Ihre öffentliche Wallet-Adresse. Zum Anmelden, zum Registrieren eines Paddles, zum Bieten oder zum Abwickeln eines Verkaufs signieren Sie eine Nachricht oder eine Transaktion mit Ihrem privaten Schlüssel. Der Schlüssel verlässt Ihr Wallet nie. Wir erhalten nur die Nachricht und die Signatur. Gebote, die Sie mit einem Paddle-Schlüssel abgeben, signiert in Ihrem Browser ein vorübergehender Schlüssel, den Ihr Wallet freigegeben hat (siehe [Cookies und lokale Speicherung](/legal/cookies)).

Daten: Wallet-Adresse, signierte Nachrichten (Inhalt, z. B. Raum, Los, Gebotshöhe, Zeitpunkt, einmalige Kennung), Signaturen, Zeitpunkt, eine interne Profilnummer, ein Sitzungs-Cookie.
Zweck: Identifizierung des Bieters, Prüfung der Gültigkeit von Geboten, Durchführung der Auktion, Schutz vor Manipulation und Mehrfachgeboten.
Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (Nutzungsvertrag mit Ihnen, siehe Nutzungsbedingungen), für Sicherheit und Missbrauchsabwehr zusätzlich Art. 6 Abs. 1 lit. f DSGVO.
Speicherdauer: Gebote und Abwicklungsdaten speichern wir bis zum Ende des dritten Kalenderjahres nach dem Jahr, in dem die Auktion endete. So lange können Ansprüche aus Geboten und Kaufverträgen geltend gemacht werden (§§ 195, 199 BGB). Das Sitzungs-Cookie läuft nach 12 Stunden ab. Einmalige Anmeldecodes gelten 5 Minuten.

### 3.3 Bieten und Abwicklung der Auktion

Bei einem Gebot prüfen wir Ihre Signatur und lesen das USDC-Guthaben Ihrer Wallet-Adresse von der Blockchain (Abschnitt 6). Den gelesenen Guthabenwert speichern wir zusammen mit dem Gebot. Gebote, der Zuschlag und das Ergebnis werden in unserer Datenbank gespeichert. Gebote und der Gebotsverlauf sind für alle Teilnehmer des Raums unter einer Paddle-Nummer sichtbar. Die signierten Gebote eines geschlossenen Loses kann jeder einsehen, und sie enthalten die Wallet-Adresse des Bieters. Beim Zuschlag erhalten Käufer und Verkäufer die Wallet-Adresse der Gegenseite, weil die Abwicklung sonst nicht möglich ist. Sie steht ohnehin öffentlich auf der Blockchain.

Zweck: Durchführung der Auktion und Vermittlung des Vertrags zwischen Käufer und Verkäufer.
Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.
Speicherdauer: siehe 3.2.

### 3.4 Verkäufer und Einlieferung

Wenn Sie als Verkäufer Karten einstellen, verarbeiten wir zusätzlich die eingestellten Karten und die Bedingungen, die Sie für jedes Los festlegen (Mindestpreis, Startpreis, Steigerung). Ihre Auszahlungsadresse ist Ihre eigene Wallet-Adresse. Einen Namen oder eine Anschrift von Verkäufern erheben wir nicht. Derzeit verkaufen auf der Plattform nur Privatpersonen.

Zweck: Vertragsdurchführung.
Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.
Speicherdauer: wie 3.2.

### 3.5 Kontakt und Meldungen

Wenn Sie uns per E-Mail schreiben oder einen Inhalt melden, verarbeiten wir Ihre E-Mail-Adresse, Ihren Namen (soweit angegeben) und den Inhalt Ihrer Nachricht. Bei einer Meldung nach Art. 16 der Verordnung (EU) 2022/2065 sind Name und E-Mail-Adresse des Meldenden erforderlich (Ausnahme: Meldungen zu Straftaten nach Art. 3 bis 7 der Richtlinie 2011/93/EU). Von der Entscheidung über die Meldung unterrichten wir den Melder und, wenn wir Inhalte beschränken, den betroffenen Nutzer. Den Namen des Melders nennen wir dem betroffenen Nutzer nur, wenn das zur Feststellung der Rechtswidrigkeit unbedingt erforderlich ist.

Zweck: Bearbeitung Ihrer Anfrage oder Meldung, Durchsetzung der Nutzungsbedingungen, Erfüllung gesetzlicher Pflichten.
Rechtsgrundlage: Art. 6 Abs. 1 lit. b, c und f DSGVO.
Speicherdauer: bis zum Abschluss der Bearbeitung, danach drei Jahre zur Verteidigung gegen Ansprüche (Art. 6 Abs. 1 lit. f DSGVO), bei Meldungen mit Entscheidung entsprechend der Dokumentationspflicht.

### 3.6 Strikes und Sperrung

Wird eine Abwicklung aus Gründen, die Sie zu vertreten haben, nicht abgeschlossen, vermerken wir einen Strike in Ihrem Profil. Nach dem zwanzigsten Strike wird Ihr Paddle ausgesetzt und Ihr Wallet gesperrt (AGB, Ziffer 8). Den Grund einer Sperrung vermerken wir ebenfalls.

Zweck: Schutz der anderen Nutzer und der Integrität der Plattform.
Rechtsgrundlage: Art. 6 Abs. 1 lit. b und f DSGVO.
Speicherdauer: wie 3.2.

### 3.7 Gesetzliche Aufbewahrung

Soweit steuer- und handelsrechtliche Vorschriften es verlangen (z. B. für Belege zu unseren Gebühreneinnahmen), bewahren wir die betreffenden Unterlagen für die gesetzlichen Fristen auf (§ 147 AO, § 257 HGB, je nach Unterlage sechs, acht oder zehn Jahre). Rechtsgrundlage ist Art. 6 Abs. 1 lit. c DSGVO.

### 3.8 Raum-Chat (optional)

Manche Räume haben einen Chat. Wenn Sie dort schreiben, speichern wir Ihre Nachricht, den Zeitpunkt, Ihre Bieternummer und die Wallet-Adresse dahinter. Eine Nachricht wird anderen erst angezeigt, wenn der Veranstalter des Raums sie freigegeben hat. Andere sehen Ihre Bieternummer, nie Ihre Wallet, und daneben Ihren Anzeigenamen, wenn Sie in Ihrem Profil einen festgelegt haben (3.13). Der Veranstalter des Raums (der Verkäufer der Show, bei Haus-Shows der Betreiber der Plattform) sieht Ihre Wallet-Adresse, um Nachrichten zu prüfen und bei Missbrauch Bieter stummzuschalten oder zu sperren. Links, E-Mail-Adressen, Telefonnummern, Nutzernamen und Wallet-Adressen werden abgelehnt. Bots schreiben nie. Wenn Sie eine Nachricht melden, speichern wir die Meldung mit Ihrer Wallet-Adresse. Der Veranstalter sieht Grund und optionale Angabe, aber nicht, wer gemeldet hat.

Zweck: Bereitstellung des Chats, den Sie nutzen, Moderation, Missbrauchsabwehr.
Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO für die Bereitstellung des Chats, Art. 6 Abs. 1 lit. f DSGVO für Moderation und Missbrauchsabwehr.
Speicherdauer: Nachrichten 30 Tage nach dem Ende der Show, spätestens 90 Tage nach dem Schreiben. Meldungen werden mit ihrer Nachricht gelöscht, spätestens nach sechs Monaten. Stummschaltungen und Sperren 30 Tage nach dem Ende der Show. Ein täglicher Lauf löscht sie. Der Chat legt nichts im Browser-Speicher ab.

### 3.9 KI-Funktionen (optional, Google)

Drei Funktionen nutzen ein KI-Modell von Google (Gemini Flash-Lite): ein KI-Entwurf für Titel und Beschreibung eines Loses im Verkaufsassistenten, ein Assistent im Raum und im Verkaufsassistenten, der die passende Antwort aus unseren eigenen FAQ auswählt, und der KI-Agent auf der Seite „KI“, der Lose sucht, einen Gebotsvorschlag vorbereitet und ein Inserat entwirft. Sie werden nur benutzt, wenn Sie die Schaltfläche drücken oder dem Agenten schreiben. Jede dieser Funktionen verlangt ein angemeldetes Wallet; Ihre Sitzung verarbeiten wir dafür wie in 3.2, senden sie aber nicht an Google. Jeder KI-Text ist als solcher gekennzeichnet, und der Verkäufer prüft einen Entwurf, bevor er verwendet wird.

Was bei einem Aufruf an Google geht: bei einem Entwurf die Kartenangaben, Ihre Notizen und, wenn Sie welche hinzufügen, bis zu drei Fotos (im Browser verkleinert, ohne Metadaten). Bei einer Frage der Fragetext (höchstens 300 Zeichen) und die Liste unserer FAQ-Fragen. Beim KI-Agenten Ihre Nachricht und die Namen und Nummern der zuletzt gefundenen Lose; die Lose selbst lesen wir aus unserer Datenbank. Wir senden nie Ihre Wallet-Adresse, Ihre IP-Adresse oder Ihre Sitzung. Wir speichern keine Eingaben, keine Fotos, keine Entwürfe, keine Fragen und kein Gespräch mit dem Agenten. Wir speichern die Zahl der Aufrufe mit Modell, Tokens und Kosten, verknüpft mit Ihrem Profil, und ein Guthabenbuch. Bitte geben Sie keine personenbezogenen Daten in Notizen oder Fragen ein.

Guthaben: Ein KI-Entwurf kostet ein Guthaben, und 1 USDC kauft 10 Guthaben. Während der Bewertungsphase können Guthaben abgeschaltet sein, KI ist dann kostenlos. Der KI-Agent verbraucht nie ein Guthaben. Sie zahlen in USDC an unsere Gebührenadresse, in einer Transaktion, die Sie signieren. Das Guthabenbuch enthält Ihr Profil, die Zahl der Guthaben und die Referenz der Zahlung. Die Zahlung ist öffentlich auf der Blockchain sichtbar. Im Testnetz hat das USDC keinen Wert.

Anbieter: Wir nutzen die Gemini API von Google LLC. Unsere Software kann alternativ Gemini auf Vertex AI von Google Cloud aufrufen. Wie Google die Eingaben behandelt, wie lange es sie aufbewahrt und ob es sie nutzt, richtet sich nach den Bedingungen von Google für den Dienst, den wir verwenden. Die Übermittlung in die USA stützt sich auf die in Abschnitt 5 genannten Garantien.

Zweck: Durchführung der von Ihnen gewählten Funktion, Kostenkontrolle.
Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.
Speicherdauer: Guthabenbuch und Nutzungseinträge wie 3.2.

### 3.10 Live-Video (optional)

Ein Verkäufer kann Live-Video für eine Show einschalten. Es ist aus, solange der Verkäufer es nicht einschaltet. Der Browser eines Zuschauers verbindet sich mit dem Video-Server (derzeit stream.bonkstream.com) erst, nachdem der Zuschauer im Raum auf „Live-Video laden“ geklickt hat. Vor diesem Klick findet keine Verbindung statt. Mit dem Klick sieht der Video-Server Ihre IP-Adresse und technische Verbindungsdaten. Ihre Entscheidung gilt für diese Show und diese Browser-Sitzung und endet mit „Video aus“ oder wenn Sie den Tab schließen. Das Kamerabild stammt vom Verkäufer, nicht von uns. Wir speichern keine Aufnahme. Wir haben nicht geprüft, wo der Video-Server steht, wer ihn sonst noch betreibt und ob er Zugriffsprotokolle führt, und nennen es deshalb hier nicht. Wenn Sie nicht wollen, dass Ihre IP-Adresse dorthin gelangt, drücken Sie die Schaltfläche nicht. In der Auktion hängt nichts vom Bild ab: Gebote und das Ende eines Loses folgen der Uhr unseres Servers.

Zweck: Anzeige des Kamerabilds des Verkäufers auf Ihren Wunsch.
Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO, Ihr Klick, und Art. 49 Abs. 1 lit. a DSGVO für die Übermittlung. Sie können mit „Video aus“ widerrufen.
Speicherdauer: Wir speichern dazu nichts. Wie lange der Video-Server Daten aufbewahrt, können wir nicht angeben.

### 3.11 Telegram-Benachrichtigungen (optional)

Wenn Sie Telegram verbinden, speichern wir Ihre Telegram-Chat-ID, die Sprache und Ihre Auswahl, welche Nachrichten Sie erhalten möchten, zusammen mit Ihrem Profil (Wallet-Adresse). Wir speichern weder Ihren Telegram-Namen noch Ihre Telefonnummer noch den Text gesendeter Nachrichten. Zur Vermeidung doppelter Nachrichten speichern wir nur, welche Benachrichtigung wir gesendet haben (Art und interne Kennung, bis zu 45 Tage). Wenn Sie „Watch“ nutzen (Alarme für die nächsten Lose eines Raums), speichern wir zusätzlich Ihr Profil, die Show und die Zahl der noch gewünschten Lose, bis die Show endet oder Sie /unwatch senden. Ein einmaliges Verbindungs-Token speichern wir nur als Hash und für 10 Minuten. Unsere Server senden Ihnen über die Telegram-Bot-Schnittstelle Nachrichten zu Ihren Geboten und Zahlungen (Los, Betrag, Frist, Link zum Raum oder zum Beleg), auf Wunsch zum Beginn einer Show, für die Sie eine Bieternummer geholt haben, und, wenn Sie Veranstalter eines Raums sind, zu Chat-Nachrichten, die auf Ihre Freigabe warten. Dabei verarbeitet Telegram die Nachrichten und Ihre Chat-ID nach eigener Datenschutzerklärung. Ihr Browser öffnet nur dann einen Link zu t.me, wenn Sie auf „Telegram verbinden“ drücken. Die Verbindung ist freiwillig und aus, solange der Betreiber die Funktion nicht eingeschaltet hat. Sie können sie jederzeit auf Ihrer Profilseite oder mit /stop im Chat trennen, dann löschen wir die gespeicherten Daten zu Telegram. Telegram-Nachrichten sind eine freiwillige Zusatzleistung ohne Gewähr für rechtzeitigen Zugang; maßgeblich bleiben die Angaben in Ihrem Konto und im Raum.

Zweck: Nachrichten zu Ihren eigenen Geboten, Zahlungen und Shows sowie Chat-Freigabe für Raum-Betreiber, auf Ihren Wunsch.
Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO, Ihr Tipp auf „Telegram verbinden“ und Start, jederzeit widerruflich, und Art. 6 Abs. 1 lit. b DSGVO für die Nachrichten zu Ihren eigenen Geboten und Verkäufen.
Speicherdauer: bis Sie trennen; die Marker gesendeter Nachrichten bis zu 45 Tage.

### 3.12 Packs und zufällige Reihenfolge der Lose (optional)

Packs: Ein Pack-Betreiber (ein unabhängiger Verkäufer) bietet echte Karten aus einem Pool mit veröffentlichten Wahrscheinlichkeiten an. Bei jedem Pack stellt Hammerprice die Technik bereit, ist nicht Verkäufer und erhält den Packpreis nicht: Bei einem Pack mit gleichem Wert zahlen Sie den Verkäufer in derselben Transaktion, die die Karte bewegt, und bei einem Zufalls-Pack zahlen Sie den Betreiber direkt und zuerst, und der Betreiber liefert die Karte in einer zweiten Transaktion, die er signiert (AGB, Ziffer 22). Um einen Pack zu öffnen, bestätigen Sie, dass Sie mindestens 18 Jahre alt sind. Wir speichern Ihre Wallet-Adresse als Käufer, den Zeitpunkt dieser Bestätigung, den Zufallswert (Seed), den Ihr Browser erzeugt, den Stand des Kaufs mit den Referenzen von Zahlung und Lieferung, die Ziehung mit ihrem Beweis und die gezogene Karte, bei einem Zufalls-Pack außerdem die Lieferfrist und ob der Betreiber geliefert hat. Das Ziehungsprotokoll und die Beweisseite sind öffentlich. Sie zeigen die Ziehung, die Festlegung des Pools und die Wallet-Adresse des Käufers, so wie es die Transaktion auf der Blockchain tut. Auch die Lieferbilanz eines Betreibers (wie viele Verkäufe geliefert, wie viele verspätet, wie viele nicht geliefert wurden, und die mittlere Lieferzeit) ist öffentlich. Die Zahlungstransaktion trägt einen Vermerk mit der Ziehungsnummer und einem Hash des Pools, der keine personenbezogenen Daten enthält. Der Betreiber des Packs erhält Ihre Wallet-Adresse, weil die Zahlung an ihn geht und die Karte aus seiner Wallet in Ihre wandert. Liefert ein Betreiber nicht, wird ein Strike im Profil des Betreibers vermerkt. Wir zählen Ihre Käufe je Wallet und Tag, um ein Tageslimit durchzusetzen.

Zweck: Durchführung des von Ihnen gewählten Kaufs, überprüfbare Ziehung, Jugendschutz, Missbrauchsgrenzen.
Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO, für Tageslimit und Altersbestätigung auch Art. 6 Abs. 1 lit. f DSGVO.
Speicherdauer: wie 3.2.

Zufällige Reihenfolge der Lose: In Haus-Shows kann die Plattform die Reihenfolge der Lose durch eine überprüfbare Zufallsziehung (ECVRF) festlegen. Die Ziehung nutzt einen Schlüssel von uns und einen Block-Hash der Blockchain, ihr Beweis ist öffentlich. Sie wird in zwei Vermerken auf die Blockchain geschrieben, die Losnummern und Hashes enthalten. Keiner enthält personenbezogene Daten.

Dankeschön-Ziehung: Nach einer Hausshow kann unter den Personen, die in ihr geboten haben, eine Paddle-Nummer gezogen werden, mit derselben Art von Ziehung. Wir verwenden die Paddle-Nummern der Bieter dieser Show, die bereits nach 3.2 gespeichert sind. Die Ziehung und ihr Beweis, die Paddle-Nummern und keine Wallet-Adresse und keinen Namen nennen, sind auf der Beweisseite öffentlich. Zweck: die Ziehung selbst und ihre Überprüfbarkeit. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO, als Zugabe zu der Auktion, an der Sie teilgenommen haben, und Art. 6 Abs. 1 lit. f DSGVO. Speicherdauer: wie 3.2.

### 3.13 Warteliste (optional)

Wenn Sie auf der Startseite Ihre E-Mail-Adresse in das Formular der Warteliste eintragen und absenden, speichern wir die Adresse (in Kleinschreibung), die Sprache der genutzten Seite und den Zeitpunkt. Wir verwenden sie nur, um Ihnen einmal mitzuteilen, dass Hammerprice im Hauptnetz (Mainnet) erreichbar ist; wir senden Ihnen nichts anderes und geben die Adresse an niemanden weiter. Das Formular enthält ein verstecktes Feld, das nur automatische Programme ausfüllen; ein Eintrag mit ausgefülltem Feld wird nicht gespeichert. Zur Missbrauchsabwehr zählen wir die Absendungen je Netzwerkadresse und Stunde in denselben Zählern wie bei den anderen Formularen; die Adresse wird nicht zu Ihrem Eintrag gespeichert. Tragen Sie eine Adresse ein, die schon auf der Liste steht, ändert sich nichts. Die Liste wird anderen Besuchern nicht angezeigt; nur der Betreiber kann sie einsehen, mit der Wallet-Anmeldung des Betreibers.

Zweck: Mitteilung an Sie, wenn Hammerprice im Hauptnetz erreichbar ist.
Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO, Ihre Einwilligung durch das Absenden des Formulars, die Sie jederzeit widerrufen können. Schreiben Sie an die Adresse in Abschnitt 1, dann löschen wir den Eintrag; der Widerruf berührt nicht, was bis dahin geschehen ist.
Speicherdauer: bis Sie die Löschung des Eintrags verlangen, sonst bis die Warteliste geschlossen wird, spätestens 24 Monate nach Ihrer Eintragung. Eine automatische Löschung gibt es derzeit nicht: Der Betreiber entfernt Einträge von Hand im Admin-Bereich.

### 3.14 Ihr Profil (optional)

Auf Ihrer Profilseite können Sie einen Benutzernamen, einen Anzeigenamen, einen Kurztext (bis 160 Zeichen) und ein Bild festlegen. Alle vier Angaben sind freiwillig, und Sie entscheiden, ob Sie sie ausfüllen. Wir speichern sie in unserer Datenbank zusammen mit Ihrem Profil (Wallet-Adresse): den Benutzernamen (3 bis 24 Buchstaben, Ziffern oder Unterstriche; er muss einmalig sein, ohne Beachtung der Groß- und Kleinschreibung), den Anzeigenamen, den Kurztext und das Bild selbst als Bilddatei bis 200 KB (png, jpeg oder webp; den Dateityp prüfen wir an der Datei selbst, SVG nehmen wir nicht an, und Metadaten in der Datei entfernen oder lesen wir nicht: die Datei wird genau so gespeichert und angezeigt, wie Sie sie hochladen, entfernen Sie darin versteckte Daten wie einen Standort deshalb vor dem Hochladen). Wir analysieren das Bild nicht und nutzen es zu keinem anderen Zweck.

Wo sie erscheinen: Ihr Benutzername, Ihr Kurztext und Ihr Bild werden auf Ihrer eigenen Profilseite angezeigt, die nur Sie öffnen können, wenn Sie angemeldet sind. Das Bild ist außerdem unter einer Webadresse abrufbar, die Ihre Profilnummer und keine Wallet-Adresse enthält (zum Beispiel `/api/avatar/<Profilnummer>`); wer diese Adresse kennt, kann das Bild laden. Wählen Sie deshalb ein Bild, das andere sehen dürfen. Ihr Anzeigename erscheint, wenn Sie einen festgelegt haben, neben Ihren Chat-Nachrichten zusammen mit Ihrer Bieternummer (3.8) und als Verkäufer Ihrer Räume. Gebote, das Gebotsprotokoll und die Live-Ansicht eines Raums zeigen immer nur Ihre Bieternummer. Ein Name oder Text mit einem Link, einer E-Mail-Adresse, einem Handle, einer Telefonnummer oder einer Wallet-Adresse wird abgelehnt, ebenso ein Name, der sich als Plattform ausgibt; die Prüfungen laufen automatisch und erfassen nicht alles, und ein Betreiber kann ein missbrauchtes Profil sperren.

Zweck: Ihr Konto wiedererkennen, ein Name für den Chat und für Ihre Räume, wenn Sie einen wünschen, und Missbrauchsabwehr bei diesen Texten und Bildern.
Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO, weil Sie die Angaben freiwillig eintragen und jederzeit widerrufen können, indem Sie das Feld leeren; für die Missbrauchsabwehr auch Art. 6 Abs. 1 lit. f DSGVO.
Speicherdauer und Löschung: bis Sie das Feld leeren oder auf Ihrer Profilseite „Bild entfernen“ drücken; die Daten werden dann aus unserer Datenbank gelöscht. Wird ein Bild ersetzt, wird die alte Datei überschrieben. Eine Änderung wird nur mit dem Namen des Feldes protokolliert, nie mit dem Inhalt. Wenn wir ein Konto sperren oder löschen, wird sein Bild nicht mehr ausgeliefert.

### 3.15 Verwaltungsbereich des Betreibers (nicht öffentlich)

Der Betreiber hat einen Verwaltungsbereich, den kein Link der Website erreicht, der nicht in der Sitemap steht, für Suchmaschinen gesperrt ist und für alle außer einigen vom Betreiber festgelegten Wallets wie eine nicht vorhandene Seite antwortet. Dort sieht der Betreiber Daten, die wir ohnehin nach diesem Abschnitt 3 speichern: Wallet-Adressen mit Profilname, Strikes, Gebote, Verkäufe und Abwicklungen, Chat-Nachrichten und Meldungen, die Warteliste und Zählwerte zur KI-Nutzung. Er kann einen Eintrag der Warteliste löschen oder sie als CSV-Datei laden, eine Chat-Nachricht ablehnen und eine noch nicht begonnene Show absagen. Jede dieser Handlungen wird mit der Wallet des Betreibers protokolliert, die E-Mail-Adresse eines Wartelisten-Eintrags nie.

Zweck: Betrieb, Support, Missbrauchsabwehr und Erfüllung Ihrer Löschwünsche.
Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO.
Speicherdauer: Der Bereich speichert selbst nichts. Eine automatische Löschung der Protokollzeilen gibt es derzeit nicht.

## 4. Empfänger und Auftragsverarbeiter

Wir geben personenbezogene Daten nur weiter, soweit das für die genannten Zwecke erforderlich ist. Mit Dienstleistern, die in unserem Auftrag Daten verarbeiten, nutzen wir die Auftragsverarbeitungsverträge, die die Anbieter bereitstellen (Art. 28 DSGVO).

{{RECIPIENTS_TABLE}}

Google (Gemini API von Google LLC bzw. Gemini auf Vertex AI von Google Cloud): Nur wenn Sie den KI-Entwurf für eine Artikelbeschreibung oder den KI-Assistenten im Raum benutzen und diese Funktionen auf der Website aktiv sind, übermitteln unsere Server die Eingaben dieses einen Aufrufs an Google: bei einem Entwurf die Kartenangaben, Ihre Notizen und, wenn Sie welche hinzufügen, bis zu drei Fotos (im Browser verkleinert, ohne Metadaten), bei einer Frage den Fragetext. Wallet-Adresse, IP-Adresse und Sitzung übermitteln wir nicht. Wir speichern keine Eingaben und keine Antworten, nur die Zahl der Aufrufe und die Kosten. Rechtsgrundlage ist die Durchführung der von Ihnen gewählten Funktion (Art. 6 Abs. 1 lit. b DSGVO). Bitte geben Sie keine persönlichen Daten ein.

Behörden, Gerichte und Berater erhalten Daten nur, soweit eine rechtliche Pflicht besteht oder wir Rechtsansprüche durchsetzen oder abwehren müssen.

## 5. Übermittlung in Drittländer

Mehrere unserer Dienstleister haben ihren Sitz in den USA oder können Daten dort verarbeiten, und unsere Funktionen und unsere Datenbank laufen in den USA (Abschnitt 4). Die Übermittlung stützen wir auf folgende Garantien, je nach Anbieter:

- den Angemessenheitsbeschluss der Europäischen Kommission zum EU-US Data Privacy Framework (Art. 45 DSGVO), soweit der Anbieter dort zertifiziert ist. Vercel Inc. ist nach eigener Angabe unter diesem Rahmen zertifiziert;
- Standardvertragsklauseln der Europäischen Kommission (Art. 46 Abs. 2 lit. c DSGVO), die Vercel und Neon in ihren Auftragsverarbeitungsverträgen vorsehen;
- bei Google (KI-Funktionen): die Garantien, die Google in seinen Bedingungen für den von uns genutzten Dienst vorsieht, nämlich die Zertifizierung unter dem EU-US Data Privacy Framework und Standardvertragsklauseln, soweit sie greifen (Art. 45 und 46 DSGVO). Wir nutzen sie nur, wenn Sie eine KI-Funktion benutzen;
- beim Video-Server: Ihre eigene Entscheidung. Sie klicken auf „Live-Video laden“ (Art. 49 Abs. 1 lit. a DSGVO). Zertifizierungen oder Vertragsklauseln dieser Anbieter haben wir nicht geprüft;
- bei den Betreibern der Solana-RPC-Dienste und beim Auslieferungsnetz für Bilder haben wir weder eine Zertifizierung noch Vertragsklauseln geprüft. Ihr Browser verbindet sich direkt mit ihnen, und die Übermittlung ist erforderlich, um die von Ihnen gewünschte Funktion zu erbringen, nämlich ein Los anzuzeigen und eine Transaktion zu lesen oder zu senden (Art. 49 Abs. 1 lit. b DSGVO).
- bei Google (KI-Funktionen) haben wir die Garantien für die Übermittlung in die USA noch nicht abschließend geprüft. Die Übermittlung ist erforderlich, um die von Ihnen gewählte Funktion zu erbringen (Art. 49 Abs. 1 lit. b DSGVO).

Unsere eigenen Funktionen laufen bei Vercel in den USA (Region iad1) und unsere Datenbank bei Neon auf AWS us-east-1 (USA). Wir hosten nicht in der EU und behaupten das auch nicht. Eine Kopie der Garantien erhalten Sie auf Anfrage.

## 6. Wallet, Abwicklung, Blockchain und Bilder

Hammerprice arbeitet mit einer öffentlichen Blockchain (Solana). Ihr Wallet läuft in Ihrer eigenen Software (Browser-Erweiterung oder App). Wir haben darauf keinen Zugriff. Ein Verkauf wird in einer Transaktion abgewickelt, die Sie und die Gegenseite mit Ihren eigenen Wallets signieren. Unser Server fügt die Signatur unserer Abwicklungsstelle hinzu, die nur Netzwerkgebühren zahlt, und sendet die Transaktion an das Netzwerk. Bei einer Auktion halten wir kein Guthaben und keinen Schlüssel, der es bewegen könnte; dasselbe gilt für Packs, bei denen die Zahlung an den Pack-Betreiber geht und nur unser Gebührenanteil an unsere Gebührenadresse (AGB, Ziffer 22). Die Transaktion ist öffentlich auf der Blockchain sichtbar.

Um Blockchain-Daten zu lesen und Transaktionen zu senden, nutzen Ihr Browser und unser Server RPC-Dienste. Ihr Browser verbindet sich direkt mit dem RPC-Server, der für das gewählte Netzwerk eingestellt ist, derzeit dem öffentlichen Solana-Endpunkt, und unser Server nutzt eigene eingestellte Endpunkte. Der RPC-Anbieter sieht dabei Ihre IP-Adresse und die abgefragten Adressen. Ihre Wallet-Erweiterung sendet eigene Anfragen, auf die wir keinen Einfluss haben.

Kartenbilder lädt Ihr Browser außerdem direkt von den Servern, auf denen die Token-Metadaten liegen, derzeit von Amazon CloudFront (Auslieferung für Collector Crypt). Dabei wird Ihre IP-Adresse an diese Server übermittelt. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO: Ohne die Bilder ließen sich Lose nicht darstellen.

Links zu einem Blockchain-Explorer (zum Beispiel Solscan) öffnen eine Seite eines Dritten erst, wenn Sie sie anklicken. Vorher laden wir nichts von dort.

## 7. Automatisierte Entscheidungen

Der Ausgang einer Auktion folgt festen, vorher bekannten Regeln: Wenn die Schlusszeit verstreicht, gewinnt das höchste gültige Gebot, das den Mindestpreis erreicht. Diese Regel wird automatisch angewendet. Sie ist Teil des Vertrags, den Sie mit uns und dem Verkäufer eingehen (Art. 22 Abs. 2 lit. a DSGVO). Auch Strikes für nicht abgeschlossene Abwicklungen werden automatisch vermerkt, und nach dem zwanzigsten Strike wird das Paddle ausgesetzt (AGB, Ziffer 8). Eine Pack-Ziehung folgt den veröffentlichten Wahrscheinlichkeiten und dem Zufallswert eines öffentlichen Beweises. Sie entscheidet, welche Karte aus dem Pack kommt, den Sie öffnen wollten, und hat sonst keine Wirkung auf Sie (Art. 22 Abs. 2 lit. a DSGVO). Dasselbe gilt für eine zufällige Reihenfolge der Lose. Wir erstellen keine Profile über Sie. Wenn Sie glauben, dass ein Ergebnis oder ein Strike fehlerhaft ist, schreiben Sie uns: Ein Mensch prüft dann den Vorgang.

## 8. Was wir nicht tun

Wir verwenden keine Analyse-, Tracking-, Werbe- oder Social-Media-Plugins, keine externen Schriftarten und keine Cookies zu Werbezwecken. Die einzigen Dritten, mit denen sich Ihr Browser direkt verbindet, sind in den Abschnitten 3.10 und 6 genannt. Ein Video eines Dritten wird nicht geladen, bevor Sie klicken. Wir verkaufen keine Daten. Wir betreiben keine Zahlungsabwicklung, verarbeiten also keine Kartendaten oder Bankverbindungen.

## 9. Blockchain und das Recht auf Löschung

Transaktionen auf der Solana-Blockchain sind öffentlich, dauerhaft und werden von Tausenden unabhängigen Teilnehmern gespeichert. Weder wir noch Sie können sie verändern oder löschen. Das gilt auch für Wallet-Adressen, die in Transaktionen vorkommen.

Deshalb gilt für uns:

- Wir schreiben keine Namen, E-Mail-Adressen oder andere Klardaten in Transaktionen. Die Abwicklungstransaktion trägt einen kurzen Vermerk mit einem Fingerabdruck (Hash) des signierten Gebotsverlaufs. Er verrät die Gebote nicht und enthält keinen Namen und keine E-Mail-Adresse, aber die erfassten Gebote sind durch Wallet-Adressen gekennzeichnet, die ohnehin öffentlich sind.
- Was wir selbst in unserer Datenbank speichern, löschen wir auf Ihr berechtigtes Verlangen, soweit keine Aufbewahrungspflicht und kein überwiegendes Interesse entgegenstehen (Abschnitt 10).
- Wir können nicht in die Blockchain eingreifen. Ein Recht auf Löschung nach Art. 17 DSGVO lässt sich dort technisch nicht erfüllen. Wenn Sie keine dauerhafte öffentliche Verknüpfung wollen, nutzen Sie ein Wallet, das nicht mit Ihrer Identität verbunden ist, und geben Sie nicht preis, wem es gehört.

Der Europäische Datenschutzausschuss (EDSA) hat diese Spannung in seinen Leitlinien 02/2025 zur Verarbeitung personenbezogener Daten in Blockchains beschrieben. Wir richten uns danach: so wenig personenbezogene Daten wie möglich auf die Kette, der Rest in einer löschbaren Datenbank.

## 10. Ihre Rechte

Sie haben gegenüber uns folgende Rechte, soweit die gesetzlichen Voraussetzungen vorliegen:

- Auskunft (Art. 15 DSGVO)
- Berichtigung (Art. 16)
- Löschung (Art. 17)
- Einschränkung der Verarbeitung (Art. 18)
- Datenübertragbarkeit (Art. 20)
- Widerspruch gegen Verarbeitungen auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO aus Gründen, die sich aus Ihrer besonderen Situation ergeben (Art. 21)
- Widerruf einer erteilten Einwilligung mit Wirkung für die Zukunft (Art. 7 Abs. 3). Wir verarbeiten nur dann auf Grundlage einer Einwilligung, wenn Sie selbst es entscheiden: wenn Sie auf „Live-Video laden“ klicken (3.10).

Schreiben Sie uns dazu an {{PRIVACY_CONTACT_EMAIL}}. Um Ihre Anfrage zuordnen zu können, nennen Sie uns die betroffene Wallet-Adresse und signieren Sie auf Wunsch eine kurze Nachricht, damit wir sicher sein können, dass Sie der Inhaber sind. Wir antworten innerhalb eines Monats.

## 11. Cookies und lokale Speicherung

Wir speichern nur, was für die von Ihnen gewünschte Nutzung erforderlich ist (§ 25 Abs. 2 Nr. 2 TDDDG): die Wahl Ihres Wallet-Anbieters, ein Sitzungs-Cookie nach der Anmeldung, den Signierschlüssel Ihres Paddles im Session Storage, den Status eines Hinweises, die Nummer eines Pack-Kaufs, den Sie gerade abschließen, und Ihre Wahl, in diesem Tab Live-Video zu laden. Die Sprache steckt in der Adresse. Dafür brauchen wir keine Einwilligung und zeigen kein Banner. Die genaue Liste steht auf der Seite [Cookies und lokale Speicherung](/legal/cookies).

## 12. Sicherheit

Die Verbindung zu unserer Website ist per TLS verschlüsselt. Zugriffe auf Datenbank und Server sind auf das Nötige beschränkt. Wir prüfen Signaturen serverseitig und vertrauen keinen Angaben des Browsers. Dennoch kann kein System vollständig sicher sein. Geben Sie niemals Ihre Seed-Phrase oder Ihren privaten Schlüssel auf einer Website ein. Wir fragen danach nie.

## 13. Minderjährige

Hammerprice richtet sich nur an Personen ab 18 Jahren. Für Packs bestätigen Sie vor jedem Kauf, dass Sie mindestens 18 Jahre alt sind. Auch die KI-Funktionen sind für Erwachsene. Wir erheben wissentlich keine Daten von Minderjährigen.

## 14. Datenquellen außerhalb Ihrer Angaben (Art. 14 DSGVO)

Wir rufen öffentlich verfügbare Blockchain-Daten und Inventardaten ab (z. B. welche Wallet-Adresse eine bestimmte Karte hält). Dazu gehören Wallet-Adressen und Bestände. Quelle sind die öffentliche Solana-Blockchain und der öffentliche Katalog von Collector Crypt. Außerdem rufen wir einen Umrechnungskurs von CoinGecko ab, wobei keine personenbezogenen Daten anfallen. Wir nutzen sie, um Karten anzuzeigen und zu prüfen, ob ein Verkäufer die Karte anbieten darf. Eine weitergehende Information Betroffener im Einzelfall wäre unverhältnismäßig (Art. 14 Abs. 5 lit. b DSGVO); diese Erklärung ist öffentlich.

## 15. Beschwerderecht bei der Aufsichtsbehörde

Sie haben das Recht, sich bei einer Datenschutzaufsichtsbehörde zu beschweren (Art. 77 DSGVO). Für uns zuständig ist:

Sächsische Datenschutz- und Transparenzbeauftragte
Maternistraße 17, 01067 Dresden
Postanschrift: Postfach 11 01 32, 01330 Dresden
Telefon: +49 351 85471-101
E-Mail: post@sdtb.sachsen.de
Internet: www.datenschutz.sachsen.de

Sie können sich auch an die Aufsichtsbehörde an Ihrem Wohnort wenden.

## 16. Änderungen

Wir passen diese Erklärung an, wenn sich unsere Verarbeitung oder die Rechtslage ändert. Die jeweils gültige Fassung steht hier mit Versionsnummer und Datum. Wesentliche Änderungen kündigen wir auf der Website an.
