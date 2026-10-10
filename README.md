# 🎮 Game Boy Online Multiplayer (Link-Cable Netplay & Live-Chat)

Ein selbstgehosteter **Game Boy (DMG) & Game Boy Color (CGB) Online-Multiplayer-Emulator** mit virtuellem **Link-Kabel**, **4-stelligem Freundescode-System**, **integriertem Live-Chat** und **PKHeX-kompatiblem `.sav` Spielstand-Manager**.

Perfekt geeignet, um im Browser gegeneinander **Tetris** zu spielen oder in **Pokémon (Gen 1 & Gen 2)** über das Internet Pokémon zu tauschen und gegeneinander anzutreten.

---

## ✨ Features

- **🔗 Echtes Link-Kabel über WebSockets:** Basiert auf dem hochpräzisen Rust/WebAssembly-Kern von [gebeh](https://github.com/itytophile/gebeh) mit Rollback-Synchronisation für flüssiges Serial-Link-Netplay.
- **🔑 Einfache 4-stellige Freundescodes:**
  - Automatisch generierte 4-stellige Codes (nur Kleinbuchstaben & Zahlen, **ohne `o`**, um Verwechslungen mit `0` auszuschließen).
  - Einladungslinks (`https://deine-domain.de/?room=abcd`) zum direkten Beitreten per Klick.
- **🕹️ Authentisches Retro Game Boy DMG Design:**
  - Detailliertes Game Boy Gehäuse mit Power-LED, interaktivem D-Pad, A/B-Buttons und 8-Bit Web-Audio-Soundeffekten.
- **💬 Integrierter Echtzeit-Chat:**
  - Eigener WebSocket-Chat (`/chat`) pro Raum inkl. Chat-Historie, Spielername und Schnell-Reaktionen (*„🎮 Bereit!“*, *„🔄 Lass tauschen!“*, *„⚔️ Kampf!“*, *„🎉 GG!“*).
- **🛡️ Session- & Reload-Schutz (Persistence Engine):**
  - Schutz vor versehentlichem Neuladen (`beforeunload`).
  - Automatisches Caching der aktiven ROM in `IndexedDB` (`gb_session_persistence`), sodass nach einem Reload sofort weitergespielt werden kann.
- **💾 `.sav` Battery-Save Manager & PKHeX-Validator:**
  - Exportiert und importiert echte **32 KB (`32.768 Bytes`) SRAM-Spielstände**.
  - **Live PKHeX-Inspektor im Browser:** Prüft Pokémon-Teamlisten, Box-Terminatoren und Gen-1/Gen-2-Checksummen und zeigt Trainer-Namen, Pokémon-Anzahl und Orden live an.
  - **Echtzeit-Sync (`🔄 Emulator sichern`):** Erzwingt das sofortige Auslesen des aktuellen WASM-RAMs ohne 5-Sekunden-Verzögerung.
  - **1-Klick Teststand (`⭐ PKHeX Teststand`):** Lädt einen vorab validierten Pokémon-Rot-Spielstand (Trainer `ROT`), der direkt in PKHeX geöffnet oder im Emulator weitergespielt werden kann.

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

## 🧪 Spielstände in PKHeX verwenden

1. **Im Spiel speichern:** Drücke im laufenden Spiel **START (`Enter`) ➔ SICHERN** und bestätige mit **JA**. *(Wichtig: Ohne Ingame-Speichern enthält der Battery-RAM nur leere `0x00`-Bytes, die PKHeX ablehnt).*
2. **Synchronisieren:** Klicke rechts im **Spielstand (.sav) Manager** auf **`🔄 Emulator sichern (Sync)`**.
3. **Status prüfen:** Sobald das grüne Badge **`PKHeX ✅`** inkl. Trainername angezeigt wird, klicke auf **`⬇️ .sav (32 KB)`**.
4. **In PKHeX bearbeiten & re-importieren:** Öffne die `.sav`-Datei in PKHeX, speichere deine Änderungen und lade sie über **`⬆️ .sav importieren`** wieder in den Browser hoch.

---

## 📁 Projektstruktur

```text
├── Dockerfile              # Node 20 Alpine Container-Konfiguration
├── docker-compose.yml      # Docker Compose Setup (Port 8000 -> 8080)
├── package.json            # Server-Abhängigkeiten (ws)
├── server.js               # HTTP-Server, ROM-API, Netplay-Relay (/ws) & Live-Chat (/chat)
├── roms/                   # Ordner für Server-ROMs (.gb/.gbc) + PKHeX-Teststand
│   ├── README.md
│   └── pokemon_rot.sav     # Validierter 32 KB Gen-1-Testspielstand
└── dist/                   # Web-Frontend & WebAssembly Emulator-Core
    ├── index.html
    ├── custom-gameboy.css  # Retro DMG Shell & Dashboard Styling
    ├── custom-ui.js        # UI-Controller, Chat, Persistence & PKHeX-Save-Engine
    └── assets/             # Kompiliertes gebeh WASM & AudioWorklet
```
