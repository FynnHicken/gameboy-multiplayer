/**
 * Game Boy Online Multiplayer - Retro UI, Live Chat & Persistence Engine
 */

(function() {
  let chatWs = null;
  let currentRoom = null;
  let currentRomName = localStorage.getItem('gb_last_rom_name') || null;
  let playerName = localStorage.getItem('gb_player_name') || 'Spieler_' + Math.floor(100 + Math.random() * 900);
  let isGameInitialized = false;

  // Sound generator using Web Audio API (Retro 8-bit Synth)
  function playRetroBlip(freq = 440, type = 'square', duration = 0.08) {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch(e) {}
  }

  // --- IndexedDB Persistence for active ROM bytes ---
  const DB_NAME = 'gb_session_persistence';
  const DB_VERSION = 1;

  function openPersistenceDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('session')) {
          db.createObjectStore('session');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveSessionRom(name, arrayBuffer) {
    try {
      currentRomName = name;
      localStorage.setItem('gb_last_rom_name', name);
      const db = await openPersistenceDb();
      const tx = db.transaction('session', 'readwrite');
      tx.objectStore('session').put({ name, buffer: arrayBuffer, timestamp: Date.now() }, 'active_rom');
      updateRomDisplay();
      refreshSaveManagerList();
    } catch(e) {
      console.warn('Failed to cache ROM in IndexedDB:', e);
    }
  }

  async function getSessionRom() {
    try {
      const db = await openPersistenceDb();
      return new Promise((resolve) => {
        const tx = db.transaction('session', 'readonly');
        const req = tx.objectStore('session').get('active_rom');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch(e) {
      return null;
    }
  }

  async function clearSessionRom() {
    try {
      currentRomName = null;
      localStorage.removeItem('gb_last_rom_name');
      const db = await openPersistenceDb();
      const tx = db.transaction('session', 'readwrite');
      tx.objectStore('session').delete('active_rom');
      updateRomDisplay();
    } catch(e) {}
  }

  // --- .sav Battery Save Management & PKHeX Validation Engine ---
  function openGebehDb() {
    return new Promise((resolve) => {
      // Use version 2 to force upgrade if empty, or just let it create if it doesn't exist
      const req = indexedDB.open('gebeh', 2);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('saves')) {
          db.createObjectStore('saves');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  // Force emulator WebAudio worklet to flush latest RAM into IndexedDB immediately
  async function forceSaveFlush() {
    try {
      if (window.__gbWorkletNode && window.__gbWorkletNode.port) {
        window.__gbWorkletNode.port.postMessage({ type: 'requestSave' });
      }
    } catch(e) {}
    // Allow AudioWorklet postMessage and IndexedDB transaction time to settle
    await new Promise(r => setTimeout(r, 200));
  }

  // Inspect raw SRAM bytes (Check empty 0x00, Gen 1/2 validity, trainer name, checksum)
  function inspectSaveBytes(bytes) {
    if (!bytes || bytes.length === 0) return { valid: false, reason: 'Keine Daten' };

    // Check if save is entirely zeroes (uninitialized / before in-game saving)
    let nonZeroCount = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0) {
        nonZeroCount++;
        if (nonZeroCount > 30) break;
      }
    }
    if (nonZeroCount === 0) {
      return {
        valid: false,
        isEmpty: true,
        reason: 'Spielstand ist noch leer (0x00). Führe im Spiel START ➔ SICHERN aus!'
      };
    }

    // Gen 1 Validation (Red / Blue / Yellow - International & German)
    // PKHeX checks: HasListAt(data, 0x2F2C, 0x30C0, 20)
    // 0x2F2C: Team-Anzahl (<= 6), terminator at 0x2F2C + 1 + count == 0xFF
    // 0x30C0: Box-Anzahl (<= 20), terminator at 0x30C0 + 1 + count == 0xFF
    const g1PartyCount = bytes[0x2F2C];
    const g1PartyTerm = bytes[0x2F2C + 1 + g1PartyCount];
    const g1BoxCount = bytes[0x30C0];
    const g1BoxTerm = bytes[0x30C0 + 1 + g1BoxCount];

    if (bytes.length === 32768 && g1PartyCount <= 6 && g1PartyTerm === 0xFF && g1BoxCount <= 20 && g1BoxTerm === 0xFF) {
      // Calculate Gen 1 Checksum (0x2598..0x3522 vs 0x3523)
      let sum = 0;
      for (let i = 0x2598; i < 0x3523; i++) {
        sum = (sum + bytes[i]) & 0xFF;
      }
      const calcChk = (~sum) & 0xFF;
      const storedChk = bytes[0x3523];
      const chkOk = (calcChk === storedChk);

      // Decode Trainer Name (Game Boy Character encoding at 0x2598..0x25A3)
      let trainer = '';
      for (let i = 0x2598; i < 0x2598 + 11; i++) {
        const b = bytes[i];
        if (b === 0x50) break;
        if (b >= 0x80 && b <= 0x99) trainer += String.fromCharCode(65 + b - 0x80);
        else if (b >= 0xA0 && b <= 0xB9) trainer += String.fromCharCode(97 + b - 0xA0);
        else if (b >= 0xF6 && b <= 0xFF) trainer += String.fromCharCode(48 + b - 0xF6);
        else trainer += '?';
      }

      // Gym Badges at 0x2602
      let badges = 0;
      const badgeByte = bytes[0x2602];
      for (let bit = 0; bit < 8; bit++) {
        if ((badgeByte >> bit) & 1) badges++;
      }

      return {
        valid: true,
        gen: 1,
        title: 'POKEMON RED',
        trainer: trainer.trim() || 'ROT',
        partyCount: g1PartyCount,
        badges,
        chkOk,
        pkhexReady: chkOk,
        size: bytes.length,
        summary: `Trainer: ${trainer.trim() || 'ROT'} | ${g1PartyCount} Pokémon | ${badges} Orden`
      };
    }

    // Gen 2 Validation (Gold / Silver / Crystal)
    const g2PartyCount = bytes[0x288A];
    const g2PartyTerm = bytes[0x288A + 1 + g2PartyCount];
    const g2BoxCount = bytes[0x2D6C];
    const g2BoxTerm = bytes[0x2D6C + 1 + g2BoxCount];

    if ((bytes.length === 32768 || bytes.length === 65536) && g2PartyCount <= 6 && g2PartyTerm === 0xFF && g2BoxCount <= 20 && g2BoxTerm === 0xFF) {
      let trainer = '';
      for (let i = 0x200B; i < 0x200B + 11; i++) {
        const b = bytes[i];
        if (b === 0x50) break;
        if (b >= 0x80 && b <= 0x99) trainer += String.fromCharCode(65 + b - 0x80);
        else if (b >= 0xA0 && b <= 0xB9) trainer += String.fromCharCode(97 + b - 0xA0);
        else if (b >= 0xF6 && b <= 0xFF) trainer += String.fromCharCode(48 + b - 0xF6);
        else trainer += '?';
      }

      return {
        valid: true,
        gen: 2,
        title: 'POKEMON_GLDAAUD',
        trainer: trainer.trim() || 'GOLD',
        partyCount: g2PartyCount,
        pkhexReady: true,
        size: bytes.length,
        summary: `Trainer: ${trainer.trim() || 'GOLD'} | ${g2PartyCount} Pokémon`
      };
    }

    return {
      valid: true,
      size: bytes.length,
      pkhexReady: false,
      summary: `Standard Game Boy Spielstand (${bytes.length} Bytes)`
    };
  }

  async function getGebehSaveTitles() {
    try {
      const db = await openGebehDb();
      if (!db || !db.objectStoreNames.contains('saves')) return [];
      return new Promise((resolve) => {
        const tx = db.transaction('saves', 'readonly');
        const req = tx.objectStore('saves').getAllKeys();
        req.onsuccess = () => {
          const keys = (req.result || []).filter(k => typeof k === 'string' && !k.endsWith('_EXTRA'));
          resolve(keys);
        };
        req.onerror = () => resolve([]);
      });
    } catch(e) {
      return [];
    }
  }

  async function exportSave(title) {
    try {
      // 1. Force emulator to flush RAM into IndexedDB
      await forceSaveFlush();

      const db = await openGebehDb();
      if (!db) return;
      const tx = db.transaction('saves', 'readonly');
      const req = tx.objectStore('saves').get(title);
      req.onsuccess = () => {
        const data = req.result;
        if (!data) {
          alert('Kein Spielstand für "' + title + '" gefunden!');
          return;
        }

        const raw = (data instanceof Uint8Array) ? data : new Uint8Array(data);
        // Ensure exact 32,768 bytes (0x8000) for standard Game Boy SRAM
        let bytes = raw;
        if (bytes.length < 32768) {
          const padded = new Uint8Array(32768);
          padded.set(bytes);
          bytes = padded;
        } else if (bytes.length > 32768 && bytes.length < 65536) {
          bytes = bytes.slice(0, 32768);
        }

        const info = inspectSaveBytes(bytes);

        if (info.isEmpty) {
          const proceed = confirm(
            `⚠️ ACHTUNG: Der Spielstand für "${title}" ist noch ungespeichert (32 KB leere Nullen)!\n\n` +
            `Externe Emulatoren werden diese Datei als ungültig ablehnen, weil im Spiel noch kein Spielstand angelegt wurde.\n\n` +
            `👉 So machst du ihn PKHeX-tauglich:\n` +
            `1. Drücke im Spiel START [Taste Enter]\n` +
            `2. Gehe auf "SICHERN" und bestätige mit JA [Taste J / A]\n` +
            `3. Klicke im Menü auf "🔄 Emulator sichern (Sync)"\n` +
            `4. Lade die .sav-Datei danach erneut herunter!\n\n` +
            `Möchtest du die leere Datei trotzdem herunterladen?`
          );
          if (!proceed) return;
        }

        const cleanName = title.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_') + '.sav';
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = cleanName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        playRetroBlip(750, 'triangle', 0.1);

        if (info.pkhexReady) {
          addChatMessage({
            type: 'system',
            text: `✅ Spielstand "${cleanName}" exportiert (${bytes.length} Bytes). Trainer: ${info.trainer} | Gültig!`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });
        }
      };
    } catch(e) {
      alert('Fehler beim Exportieren: ' + e.message);
    }
  }

  async function importSave(title, file) {
    try {
      let buffer = new Uint8Array(await file.arrayBuffer());
      if (buffer.length === 32812) {
        buffer = buffer.slice(0, 32768);
      } else if (buffer.length < 32768) {
        const padded = new Uint8Array(32768);
        padded.set(buffer);
        buffer = padded;
      }

      const info = inspectSaveBytes(buffer);
      const db = await openGebehDb();
      if (!db) return;
      const tx = db.transaction('saves', 'readwrite');
      tx.objectStore('saves').put(buffer, title);
      tx.oncomplete = () => {
        alert(`Spielstand für "${title}" erfolgreich importiert!\n\n${info.summary || (buffer.length + ' Bytes')}\nSave-Status: ${info.pkhexReady ? '100% Gültig ✅' : 'OK'}\n\nStarte das Spiel neu (oder wähle die ROM im Menü), um ihn zu spielen.`);
        playRetroBlip(880, 'square', 0.12);
        refreshSaveManagerList();
      };
    } catch(e) {
      alert('Fehler beim Importieren: ' + e.message);
    }
  }

  async function refreshSaveManagerList() {
    const list = document.getElementById('save-manager-content');
    if (!list) return;

    const titles = await getGebehSaveTitles();
    if (titles.length === 0) {
      list.innerHTML = `<div style="font-size:12px; color:#64748b; font-style:italic; padding:4px 0;">Noch keine Spielstände im Browser gesichert. Drücke im Spiel START &rarr; SICHERN.</div>`;
      return;
    }

    const db = await openGebehDb();
    if (!db) return;

    let itemsHtml = '';
    for (const title of titles) {
      let info = null;
      try {
        const raw = await new Promise(r => {
          const req = db.transaction('saves', 'readonly').objectStore('saves').get(title);
          req.onsuccess = () => r(req.result);
          req.onerror = () => r(null);
        });
        if (raw) info = inspectSaveBytes(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
      } catch(e) {}

      const isReady = info && info.pkhexReady;
      const isEmpty = info && info.isEmpty;

      itemsHtml += `
        <div style="background:#11151f; border:1px solid ${isReady ? '#166534' : isEmpty ? '#854d0e' : '#283040'}; border-radius:6px; padding:7px 10px; margin-bottom:6px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:12.5px; font-weight:700; color:#cbd5e1;">🎮 ${escapeHtml(title)}</span>
              ${isReady ? '<span style="font-size:10px; background:#166534; color:#bbf7d0; padding:1px 5px; border-radius:3px; font-weight:700;">Geprüft ✅</span>' : ''}
              ${isEmpty ? '<span style="font-size:10px; background:#854d0e; color:#fef08a; padding:1px 5px; border-radius:3px; font-weight:700;">Leer (0 KB) ⚠️</span>' : ''}
            </div>
            <button class="retro-btn" style="padding:4px 9px; font-size:11px; ${isReady ? 'background:#16a34a;' : ''}" onclick="window.gbExportSave('${escapeHtml(title)}')">⬇️ .sav (32 KB)</button>
          </div>
          ${info ? `
            <div style="font-size:11px; color:${isReady ? '#86efac' : isEmpty ? '#fde047' : '#94a3b8'}; margin-top:3px; line-height:1.3;">
              ${isEmpty ? '⚠️ Im Spiel noch ungespeichert (0x00 Nullen). Führe im Spiel <em>START &rarr; SICHERN</em> aus!' : escapeHtml(info.summary || '')}
            </div>
          ` : ''}
        </div>
      `;
    }

    list.innerHTML = itemsHtml;
  }

  window.gbExportSave = exportSave;

  // --- 1. Prevent Accidental Page Reload / Navigation ---
  window.addEventListener('beforeunload', (e) => {
    if (currentRomName || currentRoom || isGameInitialized) {
      e.preventDefault();
      e.returnValue = 'Ein Spiel oder eine Multiplayer-Session läuft noch!';
      return e.returnValue;
    }
  });

  // Update ROM info badge in sidebar
  function updateRomDisplay() {
    const label = document.getElementById('active-rom-label');
    if (label) {
      if (currentRomName) {
        label.innerHTML = `Gespeichert: <strong style="color:#48c78e;">${escapeHtml(currentRomName)}</strong> <button id="btn-clear-rom" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:11px; margin-left:6px;" title="Gespeichertes Spiel leeren">✖ Leeren</button>`;
        const clearBtn = document.getElementById('btn-clear-rom');
        if (clearBtn) {
          clearBtn.onclick = async () => {
            if (confirm('Gespeichertes Spiel aus dem Browser-Speicher entfernen?')) {
              await clearSessionRom();
              playRetroBlip(300, 'square', 0.1);
            }
          };
        }
      } else {
        label.innerHTML = `Kein Spiel zwischengespeichert`;
      }
    }
  }

  // Initialize UI layout
  function initLayout() {
    // Top bar
    if (!document.getElementById('retro-header')) {
      const header = document.createElement('header');
      header.id = 'retro-header';
      header.className = 'retro-top-bar';
      header.innerHTML = `
        <div class="retro-logo">
          <span class="retro-logo-icon">🎮</span>
          <span class="retro-logo-text">GAME BOY ONLINE</span>
        </div>
        <div class="retro-top-badges">
          <div class="room-status-badge" id="top-status-badge">
            <span class="status-dot waiting" id="top-status-dot"></span>
            <span id="top-status-text">Lobby bereit</span>
          </div>
        </div>
      `;
      document.body.prepend(header);
    }

    // Wrap root into flex layout
    const root = document.getElementById('root');
    if (root && !document.getElementById('main-retro-layout')) {
      const mainLayout = document.createElement('div');
      mainLayout.id = 'main-retro-layout';
      mainLayout.className = 'main-layout';

      // Left column: Game Boy Console
      const leftCol = document.createElement('div');
      leftCol.id = 'left-console-col';
      leftCol.className = 'console-column';

      // Right column: Dashboard & Chat
      const rightCol = document.createElement('div');
      rightCol.id = 'right-dashboard-col';
      rightCol.className = 'dashboard-panel';
      rightCol.innerHTML = `
        <!-- Matchmaking & Freundescode Card -->
        <div class="retro-card">
          <div class="retro-card-title"><span>📡</span> Freundescode & Matchmaking</div>
          <div class="room-quick-bar">
            <span class="room-code-tag" id="active-room-display">KEIN RAUM</span>
            <button class="retro-btn" id="btn-copy-invite">📋 Link kopieren</button>
            <button class="retro-btn retro-btn-secondary" id="btn-open-settings">⚙️ Raum / Einstellungen</button>
          </div>
          <div class="rom-selector-row">
            <span style="font-size:13px; font-weight:700;">🎮 Spiel:</span>
            <select class="rom-select-box" id="sidebar-rom-select">
              <option value="">-- Server-ROM wählen --</option>
            </select>
          </div>
          <div id="active-rom-label" style="font-size:11.5px; color:#94a3b8; margin-top:8px;"></div>
        </div>

        <!-- Spielstand (.sav) Manager Card -->
        <div class="retro-card">
          <details id="admin-save-panel"><summary class="retro-card-title" style="cursor:pointer; list-style:none;"><span>⚙️</span> Admin / Spielstand-Manager ▾</summary><div style="padding-top:10px;">
          <div style="font-size:12px; color:#94a3b8; margin-bottom:10px; line-height:1.4;">
            Erzeugt echte <strong>32 KB Battery-SRAM .sav</strong> Dateien für externe Emulatoren. (Immer erst im Spiel <em>START &rarr; SICHERN</em> ausführen!)
          </div>
          <div id="save-manager-content" style="margin-bottom:12px;"></div>
          <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
            <button id="btn-force-save-sync" class="retro-btn" style="font-size:11px; padding:6px 10px; background:#2563eb;" title="Synchronisiert den Emulator-RAM sofort in den Browser">
              🔄 Emulator sichern (Sync)
            </button>
            <label class="retro-btn retro-btn-secondary" style="cursor:pointer; display:inline-flex; align-items:center; gap:4px; font-size:11px; padding:6px 10px;">
              ⬆️ .sav importieren
              <input type="file" id="input-import-sav-file" accept=".sav,.bin" style="display:none;">
            </label>
            <details style="margin-top: 10px; border-top: 1px solid #334155; padding-top: 10px;">
              <summary style="font-size: 11px; color: #64748b; cursor: pointer; user-select: none;">Erweiterte Admin-Optionen</summary>
              <div style="margin-top: 8px;">
                <button id="btn-load-demo-save" class="retro-btn retro-btn-secondary" style="font-size:10px; padding:6px 9px; border-color:#eab308; color:#fde047;" title="Lädt einen vorgefertigten Pokémon Rot Spielstand zum Testen">
                  ⭐ Demo-Spielstand laden
                </button>
              </div>
            </details>
          </div>
        </div>

        </details>
        <!-- Live Chat Card -->
        <div class="retro-card chat-container">
          <div class="chat-header-bar">
            <div class="retro-card-title" style="margin-bottom:0;"><span>💬</span> Live-Chat</div>
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:11px; color:#94a3b8;">Name:</span>
              <input type="text" id="player-name-input" value="${playerName}" style="background:#0f131a; border:1px solid #334155; color:#fff; border-radius:4px; padding:2px 6px; font-size:12px; width:110px;">
            </div>
          </div>
          <div class="chat-messages" id="chat-messages-list">
            <div class="chat-msg system">
              <div class="chat-bubble">Willkommen im Chat! Tritt einem Raum bei, um mit deinem Freund zu schreiben.</div>
            </div>
          </div>
          <!-- Quick Reactions -->
          <div class="quick-reactions">
            <button class="reaction-btn" data-msg="🎮 Bereit!">🎮 Bereit!</button>
            <button class="reaction-btn" data-msg="🔄 Tausch bereit!">🔄 Tausch!</button>
            <button class="reaction-btn" data-msg="⚔️ Lass kämpfen!">⚔️ Kampf!</button>
            <button class="reaction-btn" data-msg="👏 Gutes Spiel!">👏 GG!</button>
            <button class="reaction-btn" data-msg="🔥 Noch eine Runde!">🔥 Revanche!</button>
            <button class="reaction-btn" data-msg="⏰ Moment...">⏰ Moment...</button>
          </div>
          <!-- Input -->
          <div class="chat-input-row">
            <input type="text" class="chat-input-box" id="chat-input" placeholder="Nachricht eingeben...">
            <button class="chat-send-btn" id="chat-send-btn">Senden</button>
          </div>
        </div>

        <!-- Tastatur Steuerung Legend -->
        <div class="retro-card">
          <div class="retro-card-title"><span>⌨️</span> Tastatur-Steuerung</div>
          <div class="controls-legend">
            <div class="key-badge-card"><span class="key-cap">⬅️⬆️⬇️➡️</span><span class="key-desc">D-Pad</span></div>
            <div class="key-badge-card"><span class="key-cap">A</span><span class="key-desc">A-Knopf</span></div>
            <div class="key-badge-card"><span class="key-cap">B</span><span class="key-desc">B-Knopf</span></div>
            <div class="key-badge-card"><span class="key-cap">Enter</span><span class="key-desc">Start</span></div>
            <div class="key-badge-card"><span class="key-cap">Backspace</span><span class="key-desc">Select</span></div>
          </div>
        </div>
      `;

      leftCol.appendChild(root);
      mainLayout.appendChild(leftCol);
      mainLayout.appendChild(rightCol);
      document.body.appendChild(mainLayout);

      wireEvents();
      updateRomDisplay();
      refreshSaveManagerList();
    }
  }

  // Connect to live chat WebSocket
  function connectChat(roomName) {
    if (!roomName) return;
    const cleanRoom = roomName.trim().toLowerCase();
    if (chatWs && chatWs.readyState === WebSocket.OPEN && currentRoom === cleanRoom) return;

    if (chatWs) {
      chatWs.close();
    }

    currentRoom = cleanRoom;
    localStorage.setItem('gb_last_room', cleanRoom);

    // Keep URL synchronized so F5/reload immediately keeps the room!
    const newUrl = `${window.location.pathname}?room=${encodeURIComponent(cleanRoom)}`;
    if (window.location.search !== `?room=${cleanRoom}`) {
      window.history.replaceState(null, '', newUrl);
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const chatUrl = `${protocol}//${window.location.host}/chat?room=${encodeURIComponent(cleanRoom)}&name=${encodeURIComponent(playerName)}`;

    try {
      chatWs = new WebSocket(chatUrl);

      chatWs.onopen = () => {
        addChatMessage({
          type: 'system',
          text: `Chat verbunden für Raum "${cleanRoom}"!`,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      };

      chatWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'history') {
            msg.messages.forEach(m => addChatMessage(m, false));
          } else {
            addChatMessage(msg, true);
          }
        } catch(e) {}
      };
    } catch(e) {
      console.error('Chat connection error:', e);
    }
  }

  // Add chat message to UI
  function addChatMessage(msg, playSound = true) {
    const chatList = document.getElementById('chat-messages-list');
    if (!chatList) return;

    const div = document.createElement('div');
    const isMine = msg.sender === playerName;

    if (msg.type === 'system') {
      div.className = 'chat-msg system';
      div.innerHTML = `<div class="chat-bubble">${escapeHtml(msg.text)}</div>`;
    } else {
      div.className = `chat-msg ${isMine ? 'mine' : 'theirs'}`;
      div.innerHTML = `
        <div class="chat-bubble">
          ${!isMine ? `<strong style="display:block; font-size:11px; color:#38bdf8; margin-bottom:2px;">${escapeHtml(msg.sender)}</strong>` : ''}
          ${escapeHtml(msg.text)}
        </div>
        <div class="chat-meta">${msg.time || ''}</div>
      `;
    }

    chatList.appendChild(div);
    chatList.scrollTop = chatList.scrollHeight;

    if (playSound && !isMine && msg.type !== 'system') {
      playRetroBlip(580, 'sine', 0.08);
      setTimeout(() => playRetroBlip(880, 'sine', 0.1), 80);
    }
  }

  function escapeHtml(text) {
    const p = document.createElement('p');
    p.textContent = text;
    return p.innerHTML;
  }

  // Inject a ROM into the React emulator file input
  function feedRomToEmulator(arrayBuffer, fileName) {
    const file = new File([arrayBuffer], fileName, { type: 'application/octet-stream' });
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      isGameInitialized = true;
      return true;
    }
    return false;
  }

  // Wire buttons & events
  function wireEvents() {
    // Copy invite link
    const copyBtn = document.getElementById('btn-copy-invite');
    if (copyBtn) {
      copyBtn.onclick = () => {
        if (!currentRoom) {
          alert('Bitte erstelle zuerst einen Raum (⚙️ Raum / Einstellungen) oder tritt einem bei!');
          return;
        }
        const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(currentRoom)}`;
        navigator.clipboard.writeText(inviteUrl).then(() => {
          copyBtn.innerHTML = '✅ Kopiert!';
          playRetroBlip(700, 'triangle', 0.08);
          setTimeout(() => { copyBtn.innerHTML = '📋 Link kopieren'; }, 2000);
        });
      };
    }

    // Settings Toggle button
    const settingsBtn = document.getElementById('btn-open-settings');
    if (settingsBtn) {
      settingsBtn.onclick = () => {
        const reactSettingsBtn = document.querySelector('button[class*="settingsButton"]');
        if (reactSettingsBtn) {
          reactSettingsBtn.click();
          playRetroBlip(520, 'square', 0.05);
        } else {
          const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('Close settings'));
          if (closeBtn) closeBtn.click();
        }
        setTimeout(refreshSaveManagerList, 300);
      };
    }

    // Force save flush (sync worklet RAM to IndexedDB)
    const syncBtn = document.getElementById('btn-force-save-sync');
    if (syncBtn) {
      syncBtn.onclick = async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = '⏳ Sichern...';
        await forceSaveFlush();
        playRetroBlip(880, 'triangle', 0.1);
        await refreshSaveManagerList();
        syncBtn.textContent = '✅ Gesichert!';
        setTimeout(() => {
          syncBtn.textContent = '🔄 Emulator sichern (Sync)';
          syncBtn.disabled = false;
        }, 1200);
      };
    }

    // Load pre-tested PKHeX demo save
    const demoBtn = document.getElementById('btn-load-demo-save');
    if (demoBtn) {
      demoBtn.onclick = async () => {
        try {
          const resp = await fetch('/api/roms/pokemon_rot.sav');
          if (!resp.ok) throw new Error('Teststand konnte nicht geladen werden');
          const buf = new Uint8Array(await resp.arrayBuffer());
          const db = await openGebehDb();
          if (!db) throw new Error('IndexedDB nicht erreichbar');
          const tx = db.transaction('saves', 'readwrite');
          tx.objectStore('saves').put(buf, 'POKEMON RED');
          tx.oncomplete = () => {
            alert('⭐ Test-Spielstand für "Pokémon Rot" erfolgreich aktiviert!\n\nTrainer: ROT\nStarter: Glumanda\nStatus: 100% kompatibel (32.768 Bytes).\n\nDu kannst ihn jetzt mit "⬇️ .sav" herunterladen und in externen Emulatoren öffnen oder im Spiel weiterspielen!');
            playRetroBlip(880, 'square', 0.15);
            refreshSaveManagerList();
          };
        } catch(e) {
          alert('Fehler: ' + e.message);
        }
      };
    }

    // Smart Import .sav file with automatic format & game detection
    const importInput = document.getElementById('input-import-sav-file');
    if (importInput) {
      importInput.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          let buffer = new Uint8Array(await file.arrayBuffer());
          // Handle RTC footer or padding: if 32812 bytes, trim to 32768
          if (buffer.length === 32812) {
            buffer = buffer.slice(0, 32768);
          } else if (buffer.length < 32768) {
            const padded = new Uint8Array(32768);
            padded.set(buffer);
            buffer = padded;
          }

          const info = inspectSaveBytes(buffer);
          let targetTitle = (info && info.title) ? info.title : null;
          if (!targetTitle) {
            const titles = await getGebehSaveTitles();
            const defaultTitle = titles[0] || (currentRomName && currentRomName.toUpperCase().replace(/\.[A-Z0-9]+$/, '')) || 'POKEMON RED';
            targetTitle = prompt('Für welches Spiel soll der Spielstand geladen werden? (z.B. POKEMON RED, POKEMON_GLDAAUD, TETRIS)', defaultTitle);
          }

          if (targetTitle) {
            targetTitle = targetTitle.trim().toUpperCase();
            await importSave(targetTitle, file);
          }
        } catch(err) {
          alert('Fehler beim Importieren: ' + err.message);
        }
        importInput.value = '';
      };
    }

    // Player name input
    const nameInput = document.getElementById('player-name-input');
    if (nameInput) {
      nameInput.onchange = () => {
        playerName = nameInput.value.trim() || 'Spieler';
        localStorage.setItem('gb_player_name', playerName);
        if (currentRoom) connectChat(currentRoom);
      };
    }

    // Chat send
    const sendBtn = document.getElementById('chat-send-btn');
    const chatInput = document.getElementById('chat-input');

    const sendMsg = () => {
      const text = chatInput.value.trim();
      if (!text) return;
      if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
        addChatMessage({ type: 'system', text: 'Chat noch nicht verbunden. Tritt erst einem Raum bei!' });
        return;
      }
      chatWs.send(JSON.stringify({ type: 'chat', text, sender: playerName }));
      chatInput.value = '';
      playRetroBlip(440, 'square', 0.04);
    };

    if (sendBtn) sendBtn.onclick = sendMsg;
    if (chatInput) {
      chatInput.onkeydown = (e) => {
        if (e.key === 'Enter') sendMsg();
      };
    }

    // Quick reactions
    document.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.onclick = () => {
        const text = btn.getAttribute('data-msg');
        if (chatWs && chatWs.readyState === WebSocket.OPEN) {
          chatWs.send(JSON.stringify({ type: 'chat', text, sender: playerName }));
          playRetroBlip(600, 'square', 0.05);
        } else {
          chatInput.value = text;
          chatInput.focus();
        }
      };
    });

    // Capture when user selects any file in the emulator and cache it in IndexedDB
    document.addEventListener('change', async (e) => {
      if (e.target && e.target.type === 'file' && e.target.files && e.target.files[0] && e.target.id !== 'input-import-sav-file') {
        const file = e.target.files[0];
        try {
          const buffer = await file.arrayBuffer();
          await saveSessionRom(file.name, buffer);
          isGameInitialized = true;
        } catch(err) {
          console.warn('Could not save file to IndexedDB:', err);
        }
      }
    }, true);

    // Auto-lowercase and sanitize input in React's "Room to join" field
    document.addEventListener('input', (e) => {
      if (e.target && e.target.placeholder === 'Room to join') {
        const clean = e.target.value.toLowerCase().replace(/\s+/g, '');
        if (e.target.value !== clean) {
          e.target.value = clean;
        }
      }
    });

    // Load ROMs list into sidebar
    fetch('/api/roms')
      .then(res => res.json())
      .then(roms => {
        const select = document.getElementById('sidebar-rom-select');
        if (select && Array.isArray(roms)) {
          roms.forEach(rom => {
            const opt = document.createElement('option');
            opt.value = rom;
            opt.textContent = rom;
            select.appendChild(opt);
          });

          select.onchange = async () => {
            const val = select.value;
            if (!val) return;
            try {
              const resp = await fetch(`/api/roms/${encodeURIComponent(val)}`);
              const blob = await resp.blob();
              const buffer = await blob.arrayBuffer();
              await saveSessionRom(val, buffer);
              feedRomToEmulator(buffer, val);
              playRetroBlip(880, 'triangle', 0.12);
            } catch(e) {
              alert('Fehler beim Laden: ' + e.message);
            }
          };
        }
      })
      .catch(() => {});
  }

  // Periodic Observer to sync React state with retro UI & Auto-Restore
  let hasAttemptedRomAutoRestore = false;

  async function syncLoop() {
    // 1. Detect start egg button and show attractive overlay if not started yet
    const eggButton = document.querySelector('button[class*="startButton"]');
    let overlay = document.getElementById('start-game-overlay');
    if (eggButton && !overlay) {
      overlay = document.createElement('div');
      overlay.id = 'start-game-overlay';
      overlay.className = 'start-overlay';

      const cachedRom = await getSessionRom();
      const hasCachedRom = !!cachedRom;

      overlay.innerHTML = `
        <div class="start-modal-card">
          <div style="font-size: 24px; margin-bottom: 12px;">🎮</div>
          <h2 style="font-family:'Press Start 2P', monospace; font-size:11px; color:#48c78e; margin:0 0 12px 0;">GAME BOY ONLINE</h2>
          <p style="color:#94a3b8; font-size:14px; line-height:1.5;"></p>
          ${hasCachedRom ? `<div style="background:rgba(72,199,142,0.15); border:1px solid #48c78e; border-radius:8px; padding:8px 12px; margin-top:14px; font-size:13px; color:#e2e8f0;">💾 Gespeichertes Spiel: <strong>${escapeHtml(cachedRom.name)}</strong> (wird wiederhergestellt)</div>` : ''}
          <button class="start-arcade-btn" id="start-arcade-trigger">▶ START (AUDIO)</button>
        </div>
      `;
      document.body.appendChild(overlay);

      document.getElementById('start-arcade-trigger').onclick = () => {
        playRetroBlip(440, 'triangle', 0.1);
        setTimeout(() => playRetroBlip(880, 'triangle', 0.15), 100);
        const cur=document.querySelector('button[class*="startButton"]');if(cur)cur.click();else eggButton.click();
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 250);
      };
    } else if (!eggButton && overlay) {
      overlay.remove();
    }

    // 2. Auto-restore cached ROM after audio worklet has started
    if (!eggButton && !hasAttemptedRomAutoRestore) {
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput) {
        hasAttemptedRomAutoRestore = true;
        const cached = await getSessionRom();
        if (cached && cached.buffer) {
          console.log('[AutoRestore] Restoring cached ROM:', cached.name);
          feedRomToEmulator(cached.buffer, cached.name);
          addChatMessage({
            type: 'system',
            text: `Spiel "${cached.name}" automatisch aus dem Cache wiederhergestellt!`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });
        }
      }
    }

    // 3. Detect Room Code from React UI
    const allButtons = Array.from(document.querySelectorAll('button'));
    const createdRoomBtn = allButtons.find(b => b.textContent && b.textContent.includes('🥚🐔'));
    const connectedBtn = allButtons.find(b => (b.textContent && b.textContent.includes('Connected')) || (b.textContent && b.textContent.includes('🐣🐔')));

    const roomDisplay = document.getElementById('active-room-display');
    const topStatusDot = document.getElementById('top-status-dot');
    const topStatusText = document.getElementById('top-status-text');

    if (connectedBtn) {
      if (topStatusDot) topStatusDot.className = 'status-dot connected';
      if (topStatusText) topStatusText.textContent = 'Verbunden (Link-Kabel aktiv)';
    } else if (createdRoomBtn) {
      const code = createdRoomBtn.textContent.replace('🥚🐔', '').trim().toLowerCase();
      if (code && code !== currentRoom) {
        currentRoom = code;
        if (roomDisplay) roomDisplay.textContent = code;
        connectChat(code);
      }
      if (topStatusDot) topStatusDot.className = 'status-dot waiting';
      if (topStatusText) topStatusText.textContent = `Warte auf Freund (${code})...`;
    }

    // 4. Auto-join if ?room=... is in URL
    const urlParams = new URLSearchParams(window.location.search);
    const joinRoom = urlParams.get('room');
    if (joinRoom) {
      const cleanJoin = joinRoom.trim().toLowerCase();
      if (cleanJoin !== currentRoom) {
        currentRoom = cleanJoin;
        if (roomDisplay) roomDisplay.textContent = cleanJoin;
        connectChat(cleanJoin);
        
        const input = document.querySelector('input[placeholder="Room to join"]');
        if (input && input.value !== cleanJoin) {
          input.value = cleanJoin;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          setTimeout(() => {
            const joinBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('Join room'));
            if (joinBtn) joinBtn.click();
          }, 150);
        }
      }
    }

    // Refresh savegame list periodically in case of new in-game save
    refreshSaveManagerList();
  }

  // Start initialization
  window.addEventListener('DOMContentLoaded', () => {
    initLayout();
    setInterval(syncLoop, 500);
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initLayout();
    setInterval(syncLoop, 500);
  }
})();
