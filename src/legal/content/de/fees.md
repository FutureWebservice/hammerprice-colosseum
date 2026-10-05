---
title: "Gebühren"
description: "Was Hammerprice kostet: eine Vermittlungsgebühr für Verkäufer, nichts für Käufer, und wer Netzwerkgebühren trägt."
---

# Gebühren

Version {{VERSION}}, Stand {{LAST_UPDATED}}

## Kurz gesagt

| Wer | Was | Wie viel |
|---|---|---|
| Käufer | Gebühr an Hammerprice | keine |
| Verkäufer | Vermittlungsgebühr an Hammerprice | {{PLATFORM_FEE_PERCENT}} des Zuschlagspreises, nur bei Verkauf |
| Pack-Betreiber | Vermittlungsgebühr an Hammerprice | {{PLATFORM_FEE_PERCENT}} des Packpreises, in derselben Transaktion abgezogen, der Käufer zahlt uns keine Gebühr |
| Verkäufer, optional | KI-Guthaben für KI-Entwürfe | 1 USDC kauft 10 Guthaben, ein Guthaben pro Entwurf. Während der Bewertungsphase sind Guthaben abgeschaltet (KI ist dann kostenlos). Der KI-Agent verbraucht nie ein Guthaben |
| Beide | Netzwerkgebühren der Blockchain | gering, gehen nicht an uns, siehe "Netzwerkgebühren" unten |
| Je nach Los | Urheber-Royalty, Gebühren des Tresor-Betreibers | von Dritten festgelegt, siehe "Gebühren Dritter" unten |

Bieten, Zuschauen, das Einstellen eines Loses, Ihr Profil, die Telegram-Benachrichtigungen und die Warteliste sind kostenlos. Wird ein Los nicht verkauft, zahlt der Verkäufer keine Gebühr.

## So wird die Gebühr berechnet

Die Gebühr beträgt {{PLATFORM_FEE_PERCENT}} des Zuschlagspreises in USDC, abgerundet auf die kleinste Einheit von USDC (sechs Nachkommastellen). Sie wird in derselben Blockchain-Transaktion, in der der Käufer zahlt und der Token übertragen wird, direkt an die unten genannte Gebührenadresse gezahlt. Der Verkäufer erhält den Zuschlagspreis abzüglich unserer Gebühr und abzüglich einer etwaigen Urheber-Royalty.

Gebührenadresse: {{TREASURY_WALLET}}

Beispiel: Zuschlagspreis 1.000 USDC. Unsere Gebühr: 25 USDC. Der Verkäufer erhält 975 USDC, abzüglich einer etwaigen Urheber-Royalty. Der Käufer zahlt 1.000 USDC.

## Packs und KI-Guthaben

Wenn Packs angeboten werden, wird der Preis zuerst gezahlt. Bei einem Pack mit gleichem Wert geht er an den Verkäufer, in derselben Transaktion, die die Karte bewegt, abzüglich derselben prozentualen Gebühr. Bei einem Zufalls-Pack geht der Preis direkt an den Pack-Betreiber, mit derselben prozentualen Gebühr als eigener Teil derselben Zahlung, und die Karte folgt in einer zweiten Transaktion, die der Betreiber signiert. Wir erhalten den Preis nie und können ihn deshalb nicht erstatten, wenn der Betreiber nicht liefert; die Netzwerkgebühren beider Transaktionen tragen wir. KI-Guthaben sind optional. 1 USDC kauft 10 Guthaben, und ein Entwurf kostet ein Guthaben. Sie zahlen in einer Transaktion, die Sie signieren, direkt an die oben genannte Gebührenadresse, und ein Guthaben, das nicht verbraucht wurde, weil ein Entwurf fehlschlug, wird zurückgebucht. Im Testnetz hat das USDC keinen Wert.

## Netzwerkgebühren

{{NETWORK_FEE_TEXT}} Das Anlegen eines fehlenden Token-Kontos für einen Empfänger kostet einen kleinen einmaligen SOL-Betrag. Ihn trägt, wer auch die Netzwerkgebühren trägt.

## Gebühren Dritter

Manche Token tragen eine Urheber-Royalty. Sie wird dann in derselben Transaktion aus dem Erlös des Verkäufers gezahlt. Der Tresor-Betreiber kann Gebühren für die Verwahrung oder das Einlösen der physischen Karte erheben. Diese Gebühren legen Dritte fest, sie gehen nicht an uns. Maßgeblich sind deren Bedingungen.

## Steuern

Wir sind Kleinunternehmer im Sinne von § 19 UStG, sofern im Impressum nichts anderes steht, und weisen deshalb keine Umsatzsteuer aus. Steuern auf Ihre Verkäufe oder Gewinne tragen Sie selbst. Wir geben keine Steuerberatung.

## Anzeige von Preisen

Preise auf Hammerprice gelten in USDC. Ein daneben angezeigter SOL-Wert ist eine Näherung aus einem öffentlichen Umrechnungskurs und kann vom Kurs zum Zeitpunkt des Zuschlags abweichen. Maßgeblich ist nur der USDC-Betrag.

## Änderungen

Wir können Gebühren mit einer Frist von mindestens 30 Tagen ändern. Sie gelten nicht für Lose, die bei Inkrafttreten bereits in einem Raum laufen. Einzelheiten stehen in den [Nutzungsbedingungen](/legal/agb), Ziffer 9 und 25.

Fragen: {{OPERATOR_NAME}}, {{CONTACT_EMAIL}}.
