---
title: "Risikohinweise"
description: "Was bei Kryptowerten, Stablecoins und Blockchain-Abwicklung schiefgehen kann und was Sie dagegen tun können."
---

# Risikohinweise

Version {{VERSION}}, Stand {{LAST_UPDATED}}

{{NETWORK_MODE_NOTICE}}

Hammerprice arbeitet mit Kryptowerten und Blockchain-Technik. Das hat Vorteile, bringt aber Risiken mit, die Sie bei klassischen Online-Auktionen nicht haben. Bitte lesen Sie diese Seite, bevor Sie bieten oder verkaufen. Sie ist keine Anlageberatung.

## Was Hammerprice ist und was nicht

- Wir sind ein technischer Marktplatz. Wir sind weder Verkäufer noch Käufer, keine Bank, kein Zahlungsdienstleister und kein Verwahrer.
- Bei einer Auktion halten wir nie Ihr Geld, Ihre Karten oder Ihre Schlüssel und haben keinen Schlüssel, der sie bewegen könnte. Ein Verkauf ist eine Transaktion, die Käufer und Verkäufer gemeinsam signieren. Dasselbe gilt für Packs, mit einem eigenen Risiko: Bei einem Zufalls-Pack zahlen Sie den Betreiber direkt und zuerst, wir können nichts erstatten, und Sie verlassen sich darauf, dass der Betreiber die Karte liefert (Risiko 13).
- Wir unterliegen keiner Aufsicht durch die BaFin. Es gibt keine Einlagensicherung und keine Anlegerentschädigung.
- Wo Packs angeboten werden, wird die Karte, die Sie bekommen, zufällig gezogen. (Risiko 13). Die einzige andere Zufallsziehung ist die Dankeschön-Ziehung nach einer Hausshow: Sie nennt eine Paddle-Nummer unter den Personen, die geboten haben, und vergibt keinen Preis von Wert (AGB, Ziffer 2.4). Andere Zufalls- oder Glücksspielformate bieten wir nicht an.

## Ihre Hauptrisiken

### 1. Sie sind für Ihre Schlüssel allein verantwortlich

Wer Ihre Seed-Phrase oder Ihren privaten Schlüssel kennt, kann über Ihr Wallet verfügen. Verlorene Schlüssel kann niemand wiederherstellen, auch wir nicht. Geben Sie Schlüssel und Seed-Phrase niemals auf einer Website oder gegenüber Personen an, die sich als Support ausgeben. Wir fragen nie danach. Prüfen Sie Adresse und Inhalt jeder Transaktion, bevor Sie signieren.

### 2. Transaktionen sind endgültig

Eine bestätigte Blockchain-Transaktion lässt sich nicht rückgängig machen. Wurde an eine falsche Adresse gezahlt oder ein falscher Betrag bestätigt, ist das Geld in der Regel weg. Gebote bei uns sind verbindlich und lassen sich nicht zurückziehen. Ihre USDC bleiben bis zur Abwicklung in Ihrem eigenen Wallet und sind nicht reserviert. Verschieben Sie sie nach einem Gebot und können dann nicht zahlen, scheitert der Verkauf und Sie erhalten einen Strike (AGB, Ziffer 8).

### 3. Fehler in Smart Contracts und Programmen Dritter

Wir betreiben keinen eigenen Smart Contract. Die Abwicklung nutzt Standardprogramme von Solana, die wir nicht betreiben und nicht kontrollieren: das Token-Programm für USDC und das Metaplex-Core-Programm für Karten. Sie können Fehler enthalten, angegriffen oder geändert werden, und Ihre Wallet-Software kann Fehler haben. Wir prüfen die Transaktion vor dem Senden gegen die vereinbarten Beträge, können Verluste durch Fehler in diesen Programmen aber nicht ausschließen.

### 4. Stablecoin-Risiken

Wir nutzen USDC, einen Stablecoin des Unternehmens Circle. Der Wert ist an den US-Dollar gekoppelt, kann aber von ihm abweichen. Der Emittent kann Adressen sperren oder Guthaben einfrieren, etwa auf behördliche Anordnung. Die Stabilität von USDC hängt vom Emittenten und von Rechtsrahmen ab, die wir nicht beeinflussen.

### 5. Risiko beim Tresor und bei der physischen Karte

Die Karte, auf die sich ein Token bezieht, liegt nicht bei uns, sondern bei einem Dritten in einem Tresor. Ob die Karte vorhanden ist, in welchem Zustand sie ist, ob sie versichert ist und wie sie eingelöst werden kann, bestimmt allein der Tresor-Betreiber. Fällt er aus, ändert er seine Bedingungen oder hält er die Karte nicht bereit, kann der Token seinen Wert verlieren. Beim Einlösen der Karte wird der Token vernichtet, dafür können Gebühren und Versandkosten anfallen.

### 6. Echtheit und Bewertung

Kartenzustand, Echtheit und Bewertung stammen vom Verkäufer und von Dritten (etwa Bewertungsunternehmen). Wir prüfen sie nicht. Gefälschte Karten, fehlerhafte Bewertungen und ungenaue Beschreibungen sind möglich.

### 7. Preisschwankungen und fehlende Liquidität

Preise für Sammelkarten schwanken und können stark fallen. Es gibt keine Garantie, dass Sie eine Karte wieder verkaufen können, und keinen Mindestpreis. Erfolgreiche Auktionen in der Vergangenheit sind kein Hinweis auf künftige.

### 8. Technische Risiken

Netzwerküberlastung, Ausfälle, Verzögerungen, Fehler in Wallets, Browsern oder bei Dritten können dazu führen, dass Gebote zu spät eintreffen oder Transaktionen scheitern. Auch unser Dienst kann ausfallen oder fehlerhaft sein. Hammerprice ist eine Live-Beta im Demonstrationsbetrieb und wurde bisher nicht im Hauptnetz mit echtem Geld betrieben, Fehler sind deshalb eher möglich als bei einem lange laufenden Dienst. Eine Abwicklung braucht beide Signaturen innerhalb des Abwicklungsfensters. Als Verkäufer bleiben Sie bis zu dessen Ende online. Die Netzwerkgebühren zahlt unsere Abwicklungsstelle (siehe [Gebühren](/legal/fees)); fällt sie aus oder hat sie kein SOL mehr dafür, scheitert die Abwicklung. Wenn Sie ein Paddle registrieren, hält Ihr Browser einen Schlüssel, der Gebote ohne Wallet-Fenster signieren kann, bis zum Höchstbetrag und bis zu dem Zeitpunkt, den Sie freigegeben haben. Wählen Sie einen niedrigen Höchstbetrag.

### 9. Betrug und Phishing

Es gibt gefälschte Websites, Wallet-Nachrichten und Support-Profile. Prüfen Sie die Adresse der Website und öffnen Sie nur Links aus vertrauenswürdigen Quellen. Sagt Ihnen jemand, Sie müssten "zur Sicherheit" eine Transaktion signieren oder Ihren Schlüssel angeben, ist das ein Betrug.

### 10. Rechts-, Steuer- und Regulierungsrisiken

Regeln für Kryptowerte ändern sich. Die Nutzung kann in Ihrem Land eingeschränkt sein. Gewinne und Umsätze können steuerpflichtig sein, und es können Melde- und Nachweispflichten bestehen, auch für uns. Wir geben keine Steuer- oder Rechtsberatung. Informieren Sie sich bei einem Berater.

### 11. Öffentlichkeit der Blockchain

Transaktionen sind öffentlich und dauerhaft. Wer Ihre Wallet-Adresse mit Ihrer Identität verbinden kann, sieht Ihre Käufe, Verkäufe und Bestände. Siehe [Datenschutzerklärung](/legal/datenschutz).

### 12. Bei Streit gibt es keinen zentralen Schlichter

Kaufverträge bestehen zwischen Käufer und Verkäufer. Wir entscheiden nicht über Mängel und zahlen nichts zurück, auch nicht den Preis eines Zufalls-Packs, dessen Betreiber die Karte nicht geliefert hat (Risiko 13). Sie müssen Ihre Ansprüche gegen Ihre Gegenseite selbst durchsetzen. Wie wir Meldungen behandeln, steht unter [Kontakt und Meldungen](/legal/dsa-contact).

### 13. Packs: Die Karte wird zufällig gezogen

Wenn Packs angeboten werden, heißt einen zu öffnen: einen Preis für eine Karte zu zahlen, die zufällig aus einem Pool gezogen wird. Sie können eine Karte erhalten, die weniger wert ist als der Preis, den Sie gezahlt haben. Der angegebene Wert einer Karte ist die eigene Zahl des Betreibers, kein Preisversprechen. Die Wahrscheinlichkeiten und der ganze Pool werden vor dem Kauf angezeigt und die Ziehung lässt sich nachrechnen, aber nichts garantiert ein Ergebnis. Packs sind nur für Erwachsene, Sie bestätigen, dass Sie mindestens 18 Jahre alt sind, und es gibt ein Tageslimit je Wallet. Öffnen Sie Packs nur mit Geld, das Sie verlieren können, und hören Sie auf, wenn Sie merken, dass Sie nicht aufhören können. Es gibt zwei Arten von Packs. Bei einem Zufalls-Pack zahlen Sie den unabhängigen Pack-Betreiber direkt und zuerst: Hammerprice erhält Ihre Zahlung nie, die Karte wird erst gezogen, wenn die Zahlung endgültig ist, und der Betreiber muss sie danach in einer zweiten Transaktion, die er selbst signiert, innerhalb einer Frist liefern (24 Stunden nach der Ziehung, sofern nicht anders eingestellt). Weil Hammerprice kein Geld hält, kann es nichts erstatten. Liefert der Betreiber nicht oder bewegt er die gezogene Karte weg, wird der Verkauf als nicht geliefert markiert, der Betreiber erhält einen Strike und das Pack wird pausiert, aber Sie bekommen Ihr Geld nicht von uns zurück: Sie müssen selbst gegen den Betreiber vorgehen, mit der Zahlung und dem Beweis der Ziehung, die wir Ihnen zeigen. Prüfen Sie vor der Zahlung die öffentliche Lieferbilanz des Betreibers auf der Pack-Seite und zahlen Sie nur, was Sie verlieren können. Bei einem Pack mit gleichem Wert hat jede Karte denselben Listenwert: Sie zahlen den Verkäufer, und die Karte wandert in einer Transaktion aus dessen Wallet in Ihre, Hammerprice stellt nur die Technik bereit. Ob ein Betreiber die Karten wirklich besitzt und wahrheitsgemäß beschreibt, liegt in seiner Verantwortung und wird vom System nur teilweise geprüft (die Karten werden beim Anlegen eines Packs und beim Ziehen einer Karte gegen die Wallet des Betreibers geprüft, und eine Transaktion mit gleichem Wert scheitert, wenn der Verkäufer die Karte nicht hält).

### 14. KI-Funktionen, Telegram, Live-Video und Chat

KI-Entwürfe und Antworten des Assistenten können fehlerhaft sein. Prüfen Sie jeden Text, bevor Sie sich darauf verlassen. Der Assistent gibt keine Rechts-, Steuer- oder Anlageberatung. Der KI-Agent kann Lose falsch auswählen oder einen Betrag vorschlagen, den Sie so nicht wollen; er bietet nie selbst, prüfen Sie jeden Vorschlag, bevor Sie signieren. Telegram-Nachrichten können verspätet kommen oder ausbleiben; verlassen Sie sich nicht allein darauf, dass Sie über das Ende eines Loses informiert werden. Wenn Sie auf „Live-Video laden“ klicken, sieht der Video-Server Ihre IP-Adresse, und das Bild kann verspätet kommen oder fehlen. Chat-Nachrichten gibt der Veranstalter des Raums frei, bevor andere sie sehen, und der Veranstalter sieht Ihre Wallet-Adresse.

## Was Sie tun können

- Setzen Sie nur ein, was Sie verlieren können.
- Verwenden Sie ein eigenes Wallet nur für Hammerprice und halten Sie dort nur den Betrag, den Sie brauchen.
- Lesen Sie Losbeschreibung, Verkäuferstatus und Bewertung sorgfältig.
- Prüfen Sie jede Signaturanfrage. Unklare Anfragen lehnen Sie ab.
- Sichern Sie Ihre Seed-Phrase offline und teilen Sie sie mit niemandem.

Fragen an {{OPERATOR_NAME}}: {{CONTACT_EMAIL}}.
