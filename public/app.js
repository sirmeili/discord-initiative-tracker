// ============================================================================
// Roll for Initiative — D&D Turn Tracker & Notification Client
// Supports:
//  1. 100% Serverless P2P / Cloud Relay Mode (GitHub Pages — works across Wi-Fi & 4G/5G Mobile Data!)
//  2. Local Node.js WebSocket Mode (when running node server.js locally)
//  3. Discord Embedded Activity SDK auto-detection
// ============================================================================

const CONDITIONS_LIST = [
  'Concentrating',
  'Blessed',
  'Poisoned',
  'Prone',
  'Stunned',
  'Frightened',
  'Invisible',
  'Hexed'
];

// Per-tab identity so you can open multiple browser tabs to test DM + Players
let sessionUserId = sessionStorage.getItem('dnd_user_id');
if (!sessionUserId) {
  sessionUserId = 'user_' + Math.random().toString(36).slice(2, 9);
  sessionStorage.setItem('dnd_user_id', sessionUserId);
}

const urlParams = new URLSearchParams(window.location.search);
let currentRoomId = urlParams.get('instance_id') || urlParams.get('room') || 'tavern-1';

const appState = {
  userId: sessionUserId,
  username: 'Adventurer',
  characterName: '',
  role: 'player', // 'player' | 'dm'
  soundEnabled: true,
  syncMode: 'connecting', // 'local-ws' | 'p2p-mqtt'
  room: createEmptyRoom(currentRoomId),
  activeCombatantId: null,
  onDeckCombatantId: null,
  lastHandledEventTime: 0
};

function createEmptyRoom(roomId) {
  return {
    roomId,
    dmUserId: null,
    dmName: null,
    combatStarted: false,
    round: 1,
    activeTurnIndex: 0,
    combatants: [],
    updatedAt: 0
  };
}

// ============================================================================
// Client-Side Encounter Engine (Used in Serverless / GitHub Pages P2P Mode)
// ============================================================================
function sortCombatants(room) {
  const currentActiveId = room.combatants[room.activeTurnIndex]?.id || null;

  room.combatants.sort((a, b) => {
    const aRolled = a.initiative !== null && a.initiative !== undefined;
    const bRolled = b.initiative !== null && b.initiative !== undefined;
    if (aRolled && !bRolled) return -1;
    if (!aRolled && bRolled) return 1;
    if (!aRolled && !bRolled) return a.name.localeCompare(b.name);

    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    if ((b.dexMod || 0) !== (a.dexMod || 0)) return (b.dexMod || 0) - (a.dexMod || 0);
    if (a.isNPC !== b.isNPC) return a.isNPC ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  if (room.combatStarted && currentActiveId) {
    const newIdx = room.combatants.findIndex((c) => c.id === currentActiveId);
    room.activeTurnIndex = newIdx >= 0 ? newIdx : 0;
  }
}

function getTurnOrderContext(room) {
  const rolled = room.combatants.filter(
    (c) => c.initiative !== null && c.initiative !== undefined && (c.hp === null || c.hp > 0)
  );
  if (rolled.length === 0 || !room.combatStarted) {
    return { activeCombatant: null, onDeckCombatant: null };
  }
  const activeCombatant = room.combatants[room.activeTurnIndex] || null;
  let onDeckCombatant = null;
  if (room.combatants.length > 1) {
    const nextIdx = (room.activeTurnIndex + 1) % room.combatants.length;
    onDeckCombatant = room.combatants[nextIdx];
  }
  return { activeCombatant, onDeckCombatant };
}

function applyActionToRoom(room, msg) {
  let extraEvent = null;

  switch (msg.type) {
    case 'JOIN_ROOM': {
      const { userId, username, characterName, avatar, role } = msg;
      if (role === 'dm') {
        room.dmUserId = userId;
        room.dmName = characterName || username || 'Dungeon Master';
      } else if (room.dmUserId === userId && role === 'player') {
        room.dmUserId = null;
        room.dmName = null;
      }

      if (role !== 'dm') {
        let existing = room.combatants.find((c) => c.ownerId === userId && !c.isNPC);
        if (!existing) {
          existing = {
            id: `pc_${userId}`,
            ownerId: userId,
            name: characterName || username || 'Adventurer',
            playerName: username || 'Player',
            avatar: avatar || null,
            isNPC: false,
            initiative: null,
            rawRoll: null,
            dexMod: msg.dexMod ?? 2,
            hp: msg.maxHp ?? 30,
            maxHp: msg.maxHp ?? 30,
            ac: msg.ac ?? 15,
            conditions: []
          };
          room.combatants.push(existing);
        } else {
          if (characterName) existing.name = characterName;
          if (msg.dexMod !== undefined) existing.dexMod = Number(msg.dexMod);
          if (msg.maxHp !== undefined) {
            existing.maxHp = Number(msg.maxHp);
            existing.hp = Number(msg.maxHp);
          }
          if (msg.ac !== undefined) existing.ac = Number(msg.ac);
        }
        sortCombatants(room);
      }
      extraEvent = { kind: 'USER_JOINED', userId, name: characterName || username };
      break;
    }

    case 'SUBMIT_INITIATIVE': {
      const { combatantId, ownerId, rawRoll, dexMod, manualTotal, name } = msg;
      let target = room.combatants.find(
        (c) => c.id === combatantId || (!c.isNPC && c.ownerId === ownerId)
      );
      if (!target && ownerId) {
        target = {
          id: `pc_${ownerId}`,
          ownerId,
          name: name || 'Adventurer',
          playerName: name || 'Player',
          avatar: null,
          isNPC: false,
          initiative: null,
          rawRoll: null,
          dexMod: Number(dexMod) || 0,
          hp: 30,
          maxHp: 30,
          ac: 15,
          conditions: []
        };
        room.combatants.push(target);
      }
      if (target) {
        const mod = Number(dexMod) || 0;
        target.dexMod = mod;
        if (name) target.name = name;
        if (manualTotal !== undefined && manualTotal !== null && manualTotal !== '') {
          target.initiative = Number(manualTotal);
          target.rawRoll = null;
        } else {
          const d20 = Number(rawRoll) || Math.floor(Math.random() * 20) + 1;
          target.rawRoll = d20;
          target.initiative = d20 + mod;
        }
        sortCombatants(room);
        extraEvent = {
          kind: 'INITIATIVE_ROLLED',
          combatantId: target.id,
          name: target.name,
          initiative: target.initiative,
          rawRoll: target.rawRoll,
          dexMod: target.dexMod
        };
      }
      break;
    }

    case 'ADD_NPC': {
      const { name, initiative, dexMod, hp, maxHp, ac, count, npcSeeds } = msg;
      const numToCreate = Math.min(Math.max(Number(count) || 1, 1), 10);
      const mod = Number(dexMod) || 0;

      for (let i = 0; i < numToCreate; i++) {
        const suffix = numToCreate > 1 ? ` #${i + 1}` : '';
        const seed = npcSeeds && npcSeeds[i] ? npcSeeds[i] : { id: `npc_${Date.now()}_${i}`, roll: Math.floor(Math.random() * 20) + 1 };
        let initVal = null;
        let rawVal = null;

        if (initiative !== undefined && initiative !== null && initiative !== '') {
          initVal = Number(initiative);
        } else {
          rawVal = seed.roll;
          initVal = rawVal + mod;
        }

        room.combatants.push({
          id: seed.id,
          ownerId: room.dmUserId,
          name: `${name || 'Goblin'}${suffix}`,
          playerName: 'DM (Monster/NPC)',
          avatar: null,
          isNPC: true,
          initiative: initVal,
          rawRoll: rawVal,
          dexMod: mod,
          hp: Number(hp) || 22,
          maxHp: Number(maxHp || hp) || 22,
          ac: Number(ac) || 13,
          conditions: []
        });
      }
      sortCombatants(room);
      extraEvent = { kind: 'NPC_ADDED', name };
      break;
    }

    case 'UPDATE_COMBATANT': {
      const { combatantId, updates } = msg;
      const target = room.combatants.find((c) => c.id === combatantId);
      if (target && updates) {
        if (updates.name !== undefined) target.name = updates.name;
        if (updates.initiative !== undefined) {
          target.initiative =
            updates.initiative === '' || updates.initiative === null
              ? null
              : Number(updates.initiative);
        }
        if (updates.dexMod !== undefined) target.dexMod = Number(updates.dexMod) || 0;
        if (updates.hp !== undefined) target.hp = Math.max(0, Number(updates.hp));
        if (updates.maxHp !== undefined) target.maxHp = Math.max(1, Number(updates.maxHp));
        if (updates.ac !== undefined) target.ac = Number(updates.ac) || 10;
        if (updates.conditions !== undefined) target.conditions = updates.conditions;
        sortCombatants(room);
      }
      break;
    }

    case 'REMOVE_COMBATANT': {
      const idx = room.combatants.findIndex((c) => c.id === msg.combatantId);
      if (idx !== -1) {
        room.combatants.splice(idx, 1);
        if (room.activeTurnIndex >= room.combatants.length) room.activeTurnIndex = 0;
      }
      break;
    }

    case 'NEXT_TURN': {
      if (room.combatants.length === 0) break;
      if (!room.combatStarted) {
        sortCombatants(room);
        room.combatStarted = true;
        room.round = 1;
        room.activeTurnIndex = 0;
      } else {
        room.activeTurnIndex += 1;
        if (room.activeTurnIndex >= room.combatants.length) {
          room.activeTurnIndex = 0;
          room.round += 1;
        }
      }
      const { activeCombatant, onDeckCombatant } = getTurnOrderContext(room);
      extraEvent = {
        kind: 'TURN_CHANGED',
        round: room.round,
        activeCombatant,
        onDeckCombatant,
        timestamp: msg.timestamp || Date.now()
      };
      break;
    }

    case 'PREV_TURN': {
      if (!room.combatStarted || room.combatants.length === 0) break;
      room.activeTurnIndex -= 1;
      if (room.activeTurnIndex < 0) {
        room.activeTurnIndex = room.combatants.length - 1;
        room.round = Math.max(1, room.round - 1);
      }
      const { activeCombatant, onDeckCombatant } = getTurnOrderContext(room);
      extraEvent = {
        kind: 'TURN_CHANGED',
        round: room.round,
        activeCombatant,
        onDeckCombatant,
        timestamp: msg.timestamp || Date.now()
      };
      break;
    }

    case 'PING_ACTIVE_PLAYER': {
      const { activeCombatant, onDeckCombatant } = getTurnOrderContext(room);
      if (activeCombatant) {
        extraEvent = {
          kind: 'TURN_PING',
          round: room.round,
          activeCombatant,
          onDeckCombatant,
          customMessage: msg.customMessage || `The DM awaits your action, ${activeCombatant.name}!`,
          timestamp: msg.timestamp || Date.now()
        };
      }
      break;
    }

    case 'RESET_INITIATIVE': {
      room.combatStarted = false;
      room.round = 1;
      room.activeTurnIndex = 0;
      if (msg.clearRolls) {
        room.combatants.forEach((c) => {
          c.initiative = null;
          c.rawRoll = null;
        });
      }
      if (msg.removeNPCs) {
        room.combatants = room.combatants.filter((c) => !c.isNPC);
      }
      break;
    }
  }

  room.updatedAt = Date.now();
  return extraEvent;
}

// ============================================================================
// Web Audio Synthesizer (Zero-external-asset Fantasy Chimes & Horns)
// ============================================================================
let audioCtx = null;

function ensureAudio() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function playYourTurnFanfare() {
  if (!appState.soundEnabled) return;
  ensureAudio();
  if (!audioCtx) return;

  const notes = [293.66, 369.99, 440.0, 587.33];
  notes.forEach((freq, idx) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime + idx * 0.11);

    gain.gain.setValueAtTime(0.001, audioCtx.currentTime + idx * 0.11);
    gain.gain.exponentialRampToValueAtTime(0.28, audioCtx.currentTime + idx * 0.11 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + idx * 0.11 + 0.55);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + idx * 0.11);
    osc.stop(audioCtx.currentTime + idx * 0.11 + 0.6);
  });
}

function playOnDeckChime() {
  if (!appState.soundEnabled) return;
  ensureAudio();
  if (!audioCtx) return;

  const notes = [440.0, 659.25];
  notes.forEach((freq, idx) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime + idx * 0.12);

    gain.gain.setValueAtTime(0.001, audioCtx.currentTime + idx * 0.12);
    gain.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + idx * 0.12 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + idx * 0.12 + 0.35);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(audioCtx.currentTime + idx * 0.12);
    osc.stop(audioCtx.currentTime + idx * 0.12 + 0.4);
  });
}

function playDiceSound() {
  if (!appState.soundEnabled) return;
  ensureAudio();
  if (!audioCtx) return;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(520, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(780, audioCtx.currentTime + 0.12);

  gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.16);
}

// ============================================================================
// Universal Networking Layer:
// 1. Tries local Node.js WebSocket (/ws) first if running on localhost
// 2. Automatically switches to Serverless P2P / Cloud Relay (WSS over port 443/8084)
//    so GitHub Pages works across Home Wi-Fi, Different Cities, and 4G/5G Mobile Data!
// ============================================================================
let localWs = null;
let mqttClient = null;
let currentTopic = null;

function initNetworkSync(roomCode) {
  currentRoomId = (roomCode || 'tavern-1').trim().toLowerCase();
  document.getElementById('sync-badge').textContent = `Table: ${currentRoomId}`;

  const isGitHubPages = window.location.hostname.endsWith('github.io');

  if (!isGitHubPages && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    connectLocalWebSocket();
  } else {
    connectServerlessP2PRelay();
  }
}

function connectLocalWebSocket() {
  const badge = document.getElementById('discord-status-badge');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    localWs = new WebSocket(`${protocol}//${window.location.host}/ws`);
  } catch {
    connectServerlessP2PRelay();
    return;
  }

  let opened = false;
  const fallbackTimer = setTimeout(() => {
    if (!opened) {
      localWs.close();
      connectServerlessP2PRelay();
    }
  }, 1500);

  localWs.addEventListener('open', () => {
    opened = true;
    clearTimeout(fallbackTimer);
    appState.syncMode = 'local-ws';
    badge.textContent = `Connected (Local Server + P2P Ready) • Table: ${currentRoomId}`;
    // Also connect serverless P2P relay in parallel so mobile phones on 4G/5G or GitHub Pages can join the same table!
    connectServerlessP2PRelay(true);
  });

  localWs.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'STATE_UPDATE') {
        appState.room = data.state;
        appState.activeCombatantId = data.activeCombatantId;
        appState.onDeckCombatantId = data.onDeckCombatantId;
        renderUI();
        if (data.event) handleRoomEvent(data.event);
      }
    } catch (e) {
      console.error('Failed to parse WS message', e);
    }
  });
}

function connectServerlessP2PRelay(alsoUsingLocalWs = false) {
  const badge = document.getElementById('discord-status-badge');
  if (!window.mqtt) {
    if (!alsoUsingLocalWs) badge.textContent = `Offline Mode • Table: ${currentRoomId}`;
    return;
  }

  if (mqttClient) {
    try { mqttClient.end(true); } catch {}
  }

  // EMQX Public WSS Relay over port 8084 (HTTPS/TLS — works through all Wi-Fi & 4G/5G Mobile Carrier NATs)
  const brokerUrl = 'wss://broker.emqx.io:8084/mqtt';
  mqttClient = window.mqtt.connect(brokerUrl, {
    clientId: 'dnd_' + appState.userId + '_' + Math.random().toString(16).slice(2, 6),
    clean: true,
    connectTimeout: 5000,
    reconnectPeriod: 3000
  });

  currentTopic = `dnd-initiative-tracker-v1/room/${currentRoomId}`;

  mqttClient.on('connect', () => {
    if (!alsoUsingLocalWs) {
      appState.syncMode = 'p2p-mqtt';
      badge.textContent = `⚡ Global P2P Sync Active (Wi-Fi & Mobile Data) • Table: ${currentRoomId}`;
    } else {
      badge.textContent = `⚡ Hybrid Sync Active (Local + Global P2P) • Table: ${currentRoomId}`;
    }

    mqttClient.subscribe(currentTopic, { qos: 0 }, () => {
      // Request latest state from DM or peers in this room
      publishP2P({ type: 'REQUEST_SYNC', senderId: appState.userId });
    });
  });

  mqttClient.on('message', (_topic, payloadBuffer) => {
    try {
      const msg = JSON.parse(payloadBuffer.toString());
      handleP2PMessage(msg);
    } catch (e) {
      console.warn('Invalid P2P payload', e);
    }
  });
}

function publishP2P(payload) {
  if (mqttClient && mqttClient.connected && currentTopic) {
    mqttClient.publish(
      currentTopic,
      JSON.stringify({ ...payload, roomId: currentRoomId, senderId: appState.userId }),
      { qos: 0 }
    );
  }
}

function handleP2PMessage(msg) {
  if (!msg || msg.roomId !== currentRoomId) return;

  // If a new peer joins and asks for current room state, the DM (or any peer with combatants) broadcasts a snapshot
  if (msg.type === 'REQUEST_SYNC') {
    if (msg.senderId !== appState.userId && appState.room.combatants.length > 0) {
      const isDM = appState.role === 'dm' || appState.room.dmUserId === appState.userId;
      setTimeout(() => {
        publishP2P({
          type: 'SYNC_SNAPSHOT',
          state: appState.room
        });
      }, isDM ? 80 : 350);
    }
    return;
  }

  if (msg.type === 'SYNC_SNAPSHOT') {
    if (
      msg.state &&
      (appState.room.combatants.length === 0 || (msg.state.updatedAt || 0) > (appState.room.updatedAt || 0))
    ) {
      appState.room = msg.state;
      const { activeCombatant, onDeckCombatant } = getTurnOrderContext(appState.room);
      appState.activeCombatantId = activeCombatant?.id || null;
      appState.onDeckCombatantId = onDeckCombatant?.id || null;
      renderUI();
    }
    return;
  }

  // When running in pure Serverless P2P mode (e.g., on GitHub Pages), apply the action locally
  if (appState.syncMode !== 'local-ws') {
    const evt = applyActionToRoom(appState.room, msg);
    const { activeCombatant, onDeckCombatant } = getTurnOrderContext(appState.room);
    appState.activeCombatantId = activeCombatant?.id || null;
    appState.onDeckCombatantId = onDeckCombatant?.id || null;
    renderUI();
    if (evt) handleRoomEvent(evt);
  }
}

function sendAction(payload) {
  const stamped = { ...payload, roomId: currentRoomId, timestamp: Date.now() };

  // Pre-generate deterministic NPC IDs & rolls so all P2P peers compute the exact same monster stats
  if (stamped.type === 'ADD_NPC') {
    const count = Math.min(Math.max(Number(stamped.count) || 1, 1), 10);
    stamped.npcSeeds = Array.from({ length: count }, (_, i) => ({
      id: `npc_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      roll: Math.floor(Math.random() * 20) + 1
    }));
  }

  if (localWs && localWs.readyState === WebSocket.OPEN) {
    localWs.send(JSON.stringify(stamped));
  }

  if (mqttClient && mqttClient.connected) {
    publishP2P(stamped);
  } else if (appState.syncMode !== 'local-ws') {
    // Immediate local update even if offline
    const evt = applyActionToRoom(appState.room, stamped);
    const { activeCombatant, onDeckCombatant } = getTurnOrderContext(appState.room);
    appState.activeCombatantId = activeCombatant?.id || null;
    appState.onDeckCombatantId = onDeckCombatant?.id || null;
    renderUI();
    if (evt) handleRoomEvent(evt);
  }
}

// ============================================================================
// Real-Time Notification Handler (Active Turn & On-Deck Alerts)
// ============================================================================
function handleRoomEvent(evt) {
  if (evt.kind === 'INITIATIVE_ROLLED') {
    showToast(
      `🎲 ${evt.name} rolled ${evt.initiative}!`,
      evt.rawRoll !== null
        ? `Natural ${evt.rawRoll} ${evt.dexMod >= 0 ? '+' : ''}${evt.dexMod} DEX`
        : `Manual Roll Total: ${evt.initiative}`
    );
    return;
  }

  if (evt.kind === 'TURN_CHANGED' || evt.kind === 'TURN_PING') {
    if (evt.timestamp && evt.timestamp <= appState.lastHandledEventTime) return;
    appState.lastHandledEventTime = evt.timestamp || Date.now();

    const active = evt.activeCombatant;
    const onDeck = evt.onDeckCombatant;
    if (!active) return;

    const isMyCharacterActive = !active.isNPC && active.ownerId === appState.userId;
    const isMyCharacterOnDeck =
      onDeck && !onDeck.isNPC && onDeck.ownerId === appState.userId && onDeck.id !== active.id;

    if (isMyCharacterActive) {
      playYourTurnFanfare();
      triggerFullScreenTurnAlert(active, evt.round, evt.customMessage);
      sendBrowserNotification(
        `⚔️ IT'S YOUR TURN, ${active.name.toUpperCase()}!`,
        evt.customMessage || `Round ${evt.round} — The Dungeon Master awaits your move!`
      );
    } else if (isMyCharacterOnDeck) {
      playOnDeckChime();
      showToast(
        `⚡ ON DECK: Get Ready, ${onDeck.name}!`,
        `${active.name} is acting now. Your turn is up next!`,
        'toast-ondeck'
      );
      sendBrowserNotification(
        `⚡ On Deck Next: ${onDeck.name}`,
        `Prepare your action! You are right after ${active.name}.`
      );
    } else {
      showToast(
        `⚔️ Round ${evt.round}: ${active.name}'s Turn`,
        onDeck ? `On Deck Next: ${onDeck.name}` : 'Combat in progress'
      );
    }
  }
}

function triggerFullScreenTurnAlert(combatant, round, customMessage) {
  const overlay = document.getElementById('turn-alert-overlay');
  const title = document.getElementById('alert-title');
  const subtitle = document.getElementById('alert-subtitle');

  title.textContent = `${combatant.name}, You're Up!`;
  subtitle.textContent =
    customMessage || `Round ${round} • Roll your attack, cast a spell, or make your move!`;
  overlay.classList.remove('hidden');
}

function showToast(title, body, extraClass = '') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${extraClass}`;
  toast.innerHTML = `
    <div class="toast-title">${escapeHtml(title)}</div>
    <div class="toast-body">${escapeHtml(body)}</div>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}

function sendBrowserNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try {
      new Notification(title, { body });
    } catch {}
  }
}

// ============================================================================
// UI Rendering
// ============================================================================
function renderUI() {
  const room = appState.room;
  if (!room) return;

  const isDM = appState.role === 'dm' || room.dmUserId === appState.userId;

  const roundBadge = document.getElementById('round-badge');
  roundBadge.textContent = room.combatStarted ? `⚔️ Round ${room.round}` : 'Pre-Combat Lobby';

  const dmBadge = document.getElementById('dm-badge');
  dmBadge.textContent = room.dmName ? `👑 DM: ${room.dmName}` : '👑 DM: Unclaimed';

  const dmCard = document.getElementById('dm-command-card');
  const playerCard = document.getElementById('player-roller-card');

  if (isDM) dmCard.classList.remove('hidden');
  else dmCard.classList.add('hidden');

  if (appState.role === 'dm') {
    playerCard.classList.add('hidden');
  } else {
    playerCard.classList.remove('hidden');
    document.getElementById('my-char-tag').textContent = appState.characterName || 'Adventurer';
  }

  const nextTurnBtn = document.getElementById('next-turn-btn');
  if (nextTurnBtn) {
    nextTurnBtn.textContent = room.combatStarted
      ? '⏭️ NEXT TURN'
      : '⚔️ START COMBAT (TURN 1)';
  }

  const activeCombatant = room.combatants.find((c) => c.id === appState.activeCombatantId);
  const onDeckCombatant = room.combatants.find((c) => c.id === appState.onDeckCombatantId);

  const spotlight = document.getElementById('turn-spotlight');
  const statusLabel = document.getElementById('spotlight-status-label');
  const activeNameEl = document.getElementById('spotlight-active-name');
  const onDeckNameEl = document.getElementById('spotlight-ondeck-name');

  const isMyTurnNow =
    room.combatStarted &&
    activeCombatant &&
    !activeCombatant.isNPC &&
    activeCombatant.ownerId === appState.userId;

  document.body.classList.toggle('my-active-turn', Boolean(isMyTurnNow));

  if (room.combatStarted && activeCombatant) {
    spotlight.classList.add('combat-live');
    statusLabel.textContent = isMyTurnNow
      ? `🔥 IT IS YOUR TURN RIGHT NOW! (ROUND ${room.round})`
      : `⚔️ CURRENT ACTIVE TURN • ROUND ${room.round}`;
    activeNameEl.textContent = `${activeCombatant.name} (Init ${activeCombatant.initiative ?? '—'})`;
    onDeckNameEl.textContent = onDeckCombatant ? onDeckCombatant.name : '—';
  } else {
    spotlight.classList.remove('combat-live');
    statusLabel.textContent = 'WAITING FOR INITIATIVE ROLLS';
    activeNameEl.textContent =
      room.combatants.length > 0
        ? 'Players are rolling... DM can tap Start Combat when ready!'
        : 'Join the table and roll your d20 to begin!';
    onDeckNameEl.textContent = '—';
  }

  const listEl = document.getElementById('combatant-list');
  if (room.combatants.length === 0) {
    listEl.innerHTML = `
      <div style="text-align:center; padding: 36px 16px; color: var(--text-muted);">
        No combatants in the order yet. Roll initiative on the left or add monsters as DM!
      </div>
    `;
    return;
  }

  listEl.innerHTML = room.combatants
    .map((c) => {
      const isCurrent = room.combatStarted && c.id === appState.activeCombatantId;
      const isNext =
        room.combatStarted &&
        c.id === appState.onDeckCombatantId &&
        c.id !== appState.activeCombatantId;
      const isMine = !c.isNPC && c.ownerId === appState.userId;
      const canEdit = isDM || isMine;
      const isDown = c.hp !== null && c.hp <= 0;

      const rowClasses = [
        'combatant-row',
        isCurrent ? 'is-active' : '',
        isNext ? 'is-ondeck' : '',
        isDown ? 'is-downed' : ''
      ]
        .filter(Boolean)
        .join(' ');

      const initDisplay = c.initiative !== null && c.initiative !== undefined ? c.initiative : '—';
      const modDisplay = `${c.dexMod >= 0 ? '+' : ''}${c.dexMod || 0} DEX`;

      const conditionChips = (c.conditions || [])
        .map(
          (cond) =>
            `<span class="cond-chip" data-action="toggle-cond" data-id="${c.id}" data-cond="${cond}" title="Click to remove condition">${escapeHtml(cond)} ✕</span>`
        )
        .join('');

      return `
        <div class="${rowClasses}">
          <div class="init-badge" title="${c.rawRoll ? `Rolled d20 (${c.rawRoll}) ${modDisplay}` : 'Initiative Score'}">
            <span class="init-score">${initDisplay}</span>
            <span class="init-mod">${modDisplay}</span>
          </div>

          <div class="combatant-info">
            <div class="combatant-title-line">
              <span class="combatant-name">${escapeHtml(c.name)}</span>
              ${isMine ? '<span class="tag-pill tag-you">YOU</span>' : ''}
              ${c.isNPC ? '<span class="tag-pill tag-npc">NPC / MONSTER</span>' : ''}
              ${isCurrent ? '<span class="tag-pill tag-turn">⚔️ ACTIVE TURN</span>' : ''}
              ${isNext ? '<span class="tag-pill tag-ondeck">⚡ ON DECK</span>' : ''}
            </div>

            <div class="combatant-subline">
              <span>🛡️ AC ${c.ac || 10}</span>
              ${
                c.rawRoll !== null && c.rawRoll !== undefined
                  ? `<span>🎲 Rolled ${c.rawRoll} (${modDisplay})</span>`
                  : c.initiative === null
                  ? `<span style="color: var(--gold);">⏳ Waiting to roll...</span>`
                  : `<span>✍️ Manual Roll</span>`
              }
            </div>

            <div class="conditions-bar">
              ${conditionChips}
              ${
                canEdit
                  ? `<button class="btn btn-ghost btn-sm" style="padding:1px 6px; font-size:0.68rem;" data-action="add-cond" data-id="${c.id}">+ Status</button>`
                  : ''
              }
            </div>
          </div>

          <div class="combatant-controls">
            <div class="hp-widget">
              ${
                canEdit
                  ? `<button class="hp-btn" data-action="hp-delta" data-id="${c.id}" data-delta="-1" title="-1 HP">−</button>`
                  : ''
              }
              <span class="hp-text">❤️ ${c.hp ?? 0}/${c.maxHp ?? 0}</span>
              ${
                canEdit
                  ? `<button class="hp-btn" data-action="hp-delta" data-id="${c.id}" data-delta="1" title="+1 HP">+</button>`
                  : ''
              }
            </div>

            ${
              isDM
                ? `<button class="btn btn-ghost btn-sm" data-action="edit-init" data-id="${c.id}" title="Override Initiative Score">✏️ Init</button>
                   <button class="btn btn-ghost btn-sm" data-action="remove" data-id="${c.id}" title="Remove from encounter">🗑️</button>`
                : ''
            }
          </div>
        </div>
      `;
    })
    .join('');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// DOM Event Listeners
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('room-code-input').value = currentRoomId;
  initNetworkSync(currentRoomId);

  const roleRadios = document.querySelectorAll('input[name="role"]');
  const playerStatsFields = document.getElementById('player-stats-fields');
  roleRadios.forEach((radio) => {
    radio.addEventListener('change', (e) => {
      if (e.target.value === 'dm') playerStatsFields.classList.add('hidden');
      else playerStatsFields.classList.remove('hidden');
    });
  });

  document.getElementById('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    ensureAudio();

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    const selectedRole = document.querySelector('input[name="role"]:checked')?.value || 'player';
    const charName = document.getElementById('character-name-input').value.trim() || 'Adventurer';
    const newRoomCode = document.getElementById('room-code-input').value.trim().toLowerCase() || 'tavern-1';
    const dexMod = Number(document.getElementById('join-dex-input').value) || 0;
    const maxHp = Number(document.getElementById('join-hp-input').value) || 30;
    const ac = Number(document.getElementById('join-ac-input').value) || 15;

    if (newRoomCode !== currentRoomId) {
      appState.room = createEmptyRoom(newRoomCode);
      initNetworkSync(newRoomCode);
    }

    appState.role = selectedRole;
    appState.characterName = charName;
    document.getElementById('roll-dex-mod').value = dexMod;

    sendAction({
      type: 'JOIN_ROOM',
      userId: appState.userId,
      username: appState.username,
      characterName: charName,
      role: selectedRole,
      dexMod,
      maxHp,
      ac
    });

    document.getElementById('join-modal').classList.add('hidden');
  });

  document.getElementById('switch-role-btn').addEventListener('click', () => {
    document.getElementById('join-modal').classList.remove('hidden');
  });

  const soundBtn = document.getElementById('sound-toggle-btn');
  soundBtn.addEventListener('click', () => {
    appState.soundEnabled = !appState.soundEnabled;
    soundBtn.textContent = appState.soundEnabled ? '🔊 Sound: ON' : '🔇 Sound: OFF';
  });

  document.getElementById('dismiss-alert-btn').addEventListener('click', () => {
    document.getElementById('turn-alert-overlay').classList.add('hidden');
  });

  document.getElementById('roll-d20-btn').addEventListener('click', () => {
    playDiceSound();
    const dexMod = Number(document.getElementById('roll-dex-mod').value) || 0;
    const rawRoll = Math.floor(Math.random() * 20) + 1;
    const total = rawRoll + dexMod;

    const resultBox = document.getElementById('last-roll-result');
    document.getElementById('d20-value').textContent = total;
    document.getElementById('roll-breakdown-text').textContent =
      `Rolled d20 (${rawRoll}) ${dexMod >= 0 ? '+' : ''}${dexMod} DEX = ${total}`;
    resultBox.classList.remove('hidden');

    sendAction({
      type: 'SUBMIT_INITIATIVE',
      ownerId: appState.userId,
      name: appState.characterName,
      rawRoll,
      dexMod
    });
  });

  document.getElementById('submit-manual-btn').addEventListener('click', () => {
    const manualInput = document.getElementById('manual-roll-input');
    const val = manualInput.value.trim();
    if (val === '') {
      showToast('Enter Your Roll Total', 'Type your physical dice total in the box first!');
      manualInput.focus();
      return;
    }
    playDiceSound();
    const dexMod = Number(document.getElementById('roll-dex-mod').value) || 0;
    const total = Number(val);

    const resultBox = document.getElementById('last-roll-result');
    document.getElementById('d20-value').textContent = total;
    document.getElementById('roll-breakdown-text').textContent = `Submitted Physical Roll Total = ${total}`;
    resultBox.classList.remove('hidden');

    sendAction({
      type: 'SUBMIT_INITIATIVE',
      ownerId: appState.userId,
      name: appState.characterName,
      manualTotal: total,
      dexMod
    });
  });

  document.getElementById('next-turn-btn').addEventListener('click', () => {
    sendAction({ type: 'NEXT_TURN' });
  });

  document.getElementById('prev-turn-btn').addEventListener('click', () => {
    sendAction({ type: 'PREV_TURN' });
  });

  document.getElementById('ping-player-btn').addEventListener('click', () => {
    sendAction({ type: 'PING_ACTIVE_PLAYER' });
  });

  document.getElementById('reset-combat-btn').addEventListener('click', () => {
    const clearRolls = confirm('Reset combat to Pre-Combat Lobby and clear all initiative rolls?');
    if (clearRolls) {
      const removeNPCs = confirm('Also remove all Monsters/NPCs from the board?');
      sendAction({ type: 'RESET_INITIATIVE', clearRolls: true, removeNPCs });
    }
  });

  document.getElementById('add-npc-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('npc-name').value.trim();
    const count = Number(document.getElementById('npc-count').value) || 1;
    const initVal = document.getElementById('npc-init').value.trim();
    const dexMod = Number(document.getElementById('npc-dex').value) || 0;
    const hp = Number(document.getElementById('npc-hp').value) || 22;
    const ac = Number(document.getElementById('npc-ac').value) || 13;

    sendAction({
      type: 'ADD_NPC',
      name,
      count,
      initiative: initVal === '' ? null : Number(initVal),
      dexMod,
      hp,
      maxHp: hp,
      ac
    });

    document.getElementById('npc-name').value = '';
    document.getElementById('npc-init').value = '';
    document.getElementById('npc-count').value = '1';
  });

  document.getElementById('combatant-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !appState.room) return;

    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const combatant = appState.room.combatants.find((c) => c.id === id);
    if (!combatant) return;

    if (action === 'hp-delta') {
      const delta = Number(btn.dataset.delta) || 0;
      const newHp = Math.min(combatant.maxHp, Math.max(0, (combatant.hp || 0) + delta));
      sendAction({
        type: 'UPDATE_COMBATANT',
        combatantId: id,
        updates: { hp: newHp }
      });
    } else if (action === 'add-cond') {
      const picked = prompt(
        `Enter condition for ${combatant.name} (e.g. ${CONDITIONS_LIST.join(', ')}):`,
        'Concentrating'
      );
      if (picked && picked.trim()) {
        const nextConds = Array.from(new Set([...(combatant.conditions || []), picked.trim()]));
        sendAction({
          type: 'UPDATE_COMBATANT',
          combatantId: id,
          updates: { conditions: nextConds }
        });
      }
    } else if (action === 'toggle-cond') {
      const cond = btn.dataset.cond;
      const nextConds = (combatant.conditions || []).filter((item) => item !== cond);
      sendAction({
        type: 'UPDATE_COMBATANT',
        combatantId: id,
        updates: { conditions: nextConds }
      });
    } else if (action === 'edit-init') {
      const newInit = prompt(`Set new Initiative score for ${combatant.name}:`, combatant.initiative ?? 10);
      if (newInit !== null) {
        sendAction({
          type: 'UPDATE_COMBATANT',
          combatantId: id,
          updates: { initiative: newInit === '' ? null : Number(newInit) }
        });
      }
    } else if (action === 'remove') {
      sendAction({
        type: 'REMOVE_COMBATANT',
        combatantId: id
      });
    }
  });
});
