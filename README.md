# 🎮 Game Boy Online Multiplayer (Link-Cable Netplay & Live-Chat)

Ein selbstgehosteter **Game Boy (DMG) & Game Boy Color (CGB) Online-Multiplayer-Emulator** mit virtuellem **Link-Kabel**, **4-stelligem Freundescode-System**, **integriertem Live-Chat** und **`.sav` Spielstand-Manager**.

Perfekt geeignet, um im Browser gegeneinander **Tetris** zu spielen oder in **Pokémon (Gen 1 & Gen 2)** über das Internet Pokémon zu tauschen und gegeneinander anzutreten.

---

## ✨ Features

- **🎉 Party-Hub Matchmaking (inspiriert von [NobleBrains/treffen](https://github.com/NobleBrains/treffen)):**
  - **Sofortiger Raum beim Öffnen (`?room=xxxx`):** Kein manuelles Erstellen nötig – jeder Besuch erhält sofort einen 4-stelligen Raumcode (Kleinbuchstaben & Zahlen **ohne `o`**) direkt in der URL.
  - **Header Room-Pill & QR-Code:** Einladungslink mit 1 Klick kopieren (`📋`), per **QR-Code (`📱`)** scannen, Raum wechseln (`✏️`) oder zufälligen Raum würfeln (`🎲`).
  - **Party-Couch & Spieler-Karten (`ROSTER_SYNC`):** Live-Übersicht aller Spieler im Raum mit wählbarem Avatar (18 Retro-Avatare), Farb-Rahmen, Bereit-Status, aktuell gespieltem Spiel und **Host-Krone (`👑`)** inkl. Host-Übergabe.
  - **🚀 Synchroner Party-ROM-Start:** Der Party-Host kann eine Server-ROM auswählen und mit **`🚀 Für Party starten`** zeitgleich auf den Bildschirmen aller Mitspieler im Raum booten.
- **🔗 Vollautomatisches Link-Kabel (`Auto-Link-Cable`):**
  - Sobald zwei Spieler im selben Party-Raum ein Spiel gestartet haben, verbindet sich das virtuelle Game Boy Serial-Link-Kabel **automatisch im Hintergrund** (`/ws?room=xxxx&direct=1`) – ganz ohne Untermenüs.
  - **Auto-Reconnect:** Lädt ein Spieler die Seite neu, wird das Link-Kabel nahtlos neu gekoppelt.
- **🕹️ Authentisches Retro Game Boy DMG Design:**
  - Detailliertes Game Boy Gehäuse mit integrierter Spieler- & Charakterauswahl beim Einschalten, interaktivem D-Pad, A/B-Buttons und 8-Bit Web-Audio-Soundeffekten.
- **💬 Integrierter Echtzeit-Chat:**
  - Eigener WebSocket-Chat (`/chat`) pro Raum inkl. Chat-Historie, Spielername, Avatar und Schnell-Reaktionen (*„🎮 Bereit!“*, *„🔄 Lass tauschen!“*, *„⚔️ Kampf!“*, *„🎉 GG!“*).
- **🛡️ Session- & Reload-Schutz (Persistence Engine):**
  - Schutz vor versehentlichem Neuladen (`beforeunload`).
  - Automatisches Caching der aktiven ROM in `IndexedDB` (`gb_session_persistence`), sodass nach einem Reload sofort weitergespielt werden kann.
- **💾 `.sav` Battery-Save Manager:**
  - Exportiert und importiert echte **32 KB (`32.768 Bytes`) SRAM-Spielstände**.
  - **Live Spielstand-Inspektor im Browser:** Prüft Pokémon-Teamlisten, Box-Terminatoren und Gen-1/Gen-2-Checksummen und zeigt Trainer-Namen, Pokémon-Anzahl und Orden live an.
  - **Echtzeit-Sync (`🔄 Emulator sichern`):** Erzwingt das sofortige Auslesen des aktuellen WASM-RAMs ohne Verzögerung.
  - **1-Klick Starter-Spielstand (`⭐ Starter-Spielstand`):** Lädt einen vorab validierten Pokémon-Rot-Spielstand (Trainer `ROT`), der direkt heruntergeladen oder im Emulator weitergespielt werden kann.

---

## 🚀 Schnellstart (Docker Compose)

```bash
git clone https://github.com/FynnHicken/gameboy-multiplayer.git
cd gameboy-multiplayer

# Optional: Eigene .gb / .gbc ROMs in den Ordner ./roms legen
docker compose up -d --build
```

Der Server läuft anschließend auf **`http://localhost:8000`** (intern Port `8080`).

---

## ⌨️ Steuerung

| Game Boy Taste | Tastatur (Primär) | Alternativ |
| :--- | :--- | :--- |
| **Steuerkreuz (D-Pad)** | `W` `A` `S` `D` | Pfeiltasten `↑` `←` `↓` `→` |
| **A-Knopf** | `J` | `X` / `Z` |
| **B-Knopf** | `K` | `Y` |
| **START** | `Enter` | — |
| **SELECT** | `Shift` / `Backspace` | — |

---

## 💾 Spielstände (`.sav`) exportieren & importieren

1. **Im Spiel speichern:** Drücke im laufenden Spiel **START (`Enter`) ➔ SICHERN** und bestätige mit **JA**. *(Wichtig: Ohne Ingame-Speichern enthält der Battery-RAM nur leere `0x00`-Bytes).*
2. **Synchronisieren:** Klicke rechts im **Spielstand (.sav) Manager** auf **`🔄 Emulator sichern (Sync)`**.
3. **Herunterladen:** Sobald das grüne Badge **`Verifiziert ✅`** inkl. Trainername angezeigt wird, klicke auf **`⬇️ .sav (32 KB)`**.
4. **Re-importieren:** Über **`⬆️ .sav importieren`** kannst du jeden kompatiblen 32-KB-Spielstand wieder in den Browser laden.

---

## 📁 Projektstruktur

```text
├── Dockerfile              # Node 20 Alpine Container-Konfiguration
├── docker-compose.yml      # Docker Compose Setup (Port 8000 -> 8080)
├── package.json            # Server-Abhängigkeiten (ws)
├── server.js               # HTTP-Server, ROM-API, Netplay-Relay (/ws) & Party-Hub (/chat)
├── roms/                   # Ordner für Server-ROMs (.gb/.gbc) + Starter-Spielstand
│   ├── README.md
│   └── pokemon_rot.sav     # Validierter 32 KB Gen-1-Starter-Spielstand
└── dist/                   # Web-Frontend & WebAssembly Emulator-Core
    ├── index.html
    ├── custom-gameboy.css  # Retro DMG Shell & Dashboard Styling
    ├── custom-ui.js        # UI-Controller, Party-Hub, Chat, Persistence & Save-Engine
    └── assets/             # Kompiliertes gebeh WASM & AudioWorklet
```
