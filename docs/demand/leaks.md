# Signal leakage evidence

Last updated: 2026-11-23

Paid trading signals are leaked and redistributed for free at scale. This file documents public channels, accounts and websites that repost paid ("VIP") signals, including a full website that claims to aggregate more than 390 paid channels and a single leaker who publicly advertises leaking leaders who charge $240 to $500 a month.

This is the problem Sigmax closes: today a leader must share a signal in plain text, so any paying member can copy, forward or resell it.

## Summary

| Metric | Value (checked 2026-11-23) |
| --- | --- |
| Public Telegram leak channels listed | 5 |
| Combined members of those channels | about 53,500 |
| Paid channels a single leak website claims to redistribute | 280+ crypto, 110+ forex |
| Subscription prices of leaked leaders, as advertised by the leaker | $240 and $500 per month |
| Markets affected | Crypto and forex |

## Method

- Only public sources are listed: channels that open without an invite, public X accounts and a public website.
- Member counts are the numbers Telegram (or the directory named) displayed on the date checked.
- Claims made by a leaker or a leak site are reported as their claims, not as verified facts.
- Leaders whose signals were leaked are described, not named, to protect them.
- Several sources are in Arabic; a short English summary is given for each. Leakage is not specific to one language or region: the sources below cover Arabic and English channels, crypto and forex.

## 1. Leaking as a business: one subscription, hundreds of channels

| Source | What it does |
| --- | --- |
| [digileak.org/crypto-signals](https://digileak.org/crypto-signals) | A full website for leaked signals. It claims to aggregate more than 280 paid crypto channels and more than 110 paid forex channels, re-posts their trades automatically through bots, and keeps the name of the original source channel on each trade. |
| [x.com/CryptoVipPass](https://x.com/CryptoVipPass) (account now unavailable) | Offered access to about 170 paid channels for a single subscription, collecting the payments itself while leaking all of them. The account is no longer available after public backlash. |

A single paying member, or a bot inside a channel, is enough to redistribute a leader's whole product.

## 2. Case study: a leaker who advertises in public

One leaker runs public X posts and public Telegram channels where paid signals are re-posted for free. The X posts are from 2024; the channels are still active today (see below).

| Date | Post | English summary |
| --- | --- | --- |
| 2024-04-25 | [x.com/Tren_Nd/status/1783444895132155963](https://x.com/Tren_Nd/status/1783444895132155963) | Announces leaking, for free, the trades of a leader whose subscription costs $240 a month. |
| 2024-05-07 | [x.com/Tren_Nd/status/1787818616475304428](https://x.com/Tren_Nd/status/1787818616475304428) | Asks followers whether to leak a leader whose subscription costs $500 a month. |
| 2024-08-28 | [x.com/Tren_Nd/status/1828829491604443272](https://x.com/Tren_Nd/status/1828829491604443272) | Says they leaked another leader who charges $240 a month, and that everything this leader posts is re-posted for free. |

The posts above date from 2024, but the operation has not stopped: as of 2026-11-23, both Telegram channels linked to them are still active and still post signals.

| Channel | Members (2026-11-23) | Status (2026-11-23) |
| --- | --- | --- |
| [t.me/shimaa_Feactal_Vip](https://t.me/shimaa_Feactal_Vip) | 16,764 | Active, still posting signals |
| [t.me/Shimma_Magic](https://t.me/Shimma_Magic) | 7,830 | Active, still posting signals |

For the leader charging $240 a month, every member who reads the free copy instead of subscribing is lost revenue, and the leader's entries are visible to anyone before they play out.

## 3. Other public leak channels and accounts

| Source | Market | Members | Notes |
| --- | --- | --- | --- |
| [t.me/crypto_signal_leaks](https://t.me/crypto_signal_leaks) | Crypto | 20,600 | Channel dedicated to leaked crypto signals |
| [t.me/cryptoleakss](https://t.me/cryptoleakss) | Crypto | about 7,670 ([Verpips directory](https://verpips.com/en/directory/cryptoleakss)) | Posts crypto trade signals and references VIP and Premium subscriptions |
| [t.me/cryptotradingleaks](https://t.me/cryptotradingleaks) | Crypto | 700 | Leaked crypto trading signals |
| [x.com/Fxinleaks](https://x.com/Fxinleaks) | Forex | n/a (X account) | Leaks forex trades only |

## 4. Leaders already try, and pay, to stop it

The leakage problem is recognized across the industry, and the tools that exist only slow it down:

- Cornix, a signal auto-trading platform used by over 100,000 traders, ships a dedicated [Anti-Leak feature](https://help.cornix.io/en/articles/6397363-anti-leak) to protect channels against bots that copy their signals.
- Telegram added a "Restrict Saving Content" setting that blocks forwarding, but members can still retype or photograph a signal.
- Scammers join VIP groups to leak the signals of multiple channels and sell their own VIP service ([BeInCrypto](https://beincrypto.com/?p=132329)).
- Signal providers report subscribers reselling their signals through private chat groups ([MQL5 forum](https://www.mql5.com/en/forum/193436/page3)).

All of these act after the signal has already been shown in plain text to every member. None of them removes the plain text.

## Why Sigmax closes this

In Sigmax a follower never receives the signal text. The leader encrypts each signal in the browser to an attested enclave key, and only a hash is published on Stellar before execution. The enclave sizes and executes the trade inside each follower's own vault, within the limits the follower sets. There is nothing for a member to screenshot, forward or resell before execution, and take-profit and stop-loss levels stay hidden until they trigger. The leader is paid through an on-chain subscription, and their track record is public and verifiable.
